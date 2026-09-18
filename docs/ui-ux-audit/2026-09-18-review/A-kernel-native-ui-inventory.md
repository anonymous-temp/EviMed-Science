# A — Kernel-native UI inventory (DSH client 0.1.5-rc.2)

Read-only technical inventory of the DeepSeek Harness browser client we embed, and of what EviMed
currently uses, disables, shadows or ignores.

Primary source: the client packages extracted from the production runtime image to `/tmp/dshc/`
(47 client packages + the `dsh-client-0.1.5-rc.2.tgz`). Each lives at
`/tmp/dshc/@deepseek-ai+dsh-client-<name>@0.1.5-rc.2_.../node_modules/@deepseek-ai/dsh-client-<name>/`;
below, paths are abbreviated to `<name>/…` for that prefix.
Repo source: `/home/coder/workspace/EviMedScience/OpenScience/`.

Already-established live facts are in `00-live-findings.md` in this directory and are not repeated.

Status: COMPLETE.

- [x] Section 0 — package inventory table
- [x] T1 — Right sidebar
- [x] T2 — Progress / transparency surfaces
- [x] T3 — Theming
- [x] T4 — Composer & commands
- [x] T5 — Locale
- [x] T6 — Other native capabilities
- [x] Final table — native capability → state → recommendation → risk

---

## Section 0 — every client package

### How to read the columns

- **Declares** — slot keys this package *creates* (a `SlotMap` augmentation in its `lib/types/**/*.d.ts`;
  the declaration is committed by the `register()` call that owns the parent seat —
  `ui-renderer/lib/types/client/registry.d.ts:84-100`).
- **Occupies** — slot keys this package registers a component into
  (`slots.register({ name: … })` in `lib/client.js`).
- **Needs** — its `dsh.client.inject` roster from `package.json` (abbreviated: `api-*` = `@deepseek-ai/dsh-api-*`,
  the rest are `@deepseek-ai/dsh-client-*`).
- **Locale ns** — the namespace(s) it adds to `LocaleNamespaceMap`.
- **State** — `on` = active in our hosted composition; `disabled` = in `HOSTED_DISABLED_BROWSER_PANELS`
  (`apps/server/src/dshProfilePatch.mjs:302-331`); `operator-only` = `OPERATOR_ONLY_BROWSER_PANELS`
  (`dshProfilePatch.mjs:290-292`, applied at `dshProfilePatch.mjs:261-271`); `not-composed` = the package
  ships in the client bundle but the image's composition has no row for it
  (`deploy/runtime-dsh/dump-config.baseline.json:454-548`).

Two facts that apply to the whole table:

1. **Wire methods are centralised.** Only `dsh-client-connection` carries the method-name strings
   (`connection/lib/client.js`, one `typert` registry: `session/*`, `workspace/*`, `workspaceFiles/*`,
   `settings/*`, `credentials/*`, `llm/*`, `goals/*`, `agentPresets/*`, `directoryPicker/*`,
   `deliverables/presented`, `skills/list`, `plan/mode`, `gateway/*`). Feature packages call typed remote
   faces (`workspaceFiles.list(…)`, `goals.edit(…)`, `skills.list(…)`), so the column below lists the
   **remote face** each package touches — that is what maps onto our namespace deny list in
   `packages/domain/src/runtimeUiSurface.mjs:57-104`.
2. **`@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/dsh-client-ui-slots` are not in `/tmp/dshc`.**
   They are injected by `ui-jobs`, `ui-schedule`, `ui-subagent` and are the type home of `SlotMap`, but were
   not extracted — they live in the web shell's static module table
   (`ui-renderer/README.md`, "Identity" paragraph). Statements about them below are inferred from the
   `.d.ts` that augment them, not read from their source. **Cannot be determined from the extracted files.**

### Infrastructure (no UI of its own)

| Package | What it provides | Declares | Occupies | Needs | Locale ns | Remote faces | State |
|---|---|---|---|---|---|---|---|
| `connection` | Authenticated RPC transport, generation lifecycle, the whole method-name registry | — | `tool.call.toolview` | (none) `immediately: true` | — | **all** | on |
| `modules` | Lazy-CJS module table the vendored cordis Loader consumes; composes the `__DSH_BOOT__` entry graph | — | — | — | — | — | on |
| `resources` | URL-addressed resource providers behind the `useResource` hook | — | — | `ui-renderer` | — | — | on |
| `file-upload` | Agent-scoped browser upload + staged receipt; registers a raw POST at `/api/session/uploadFileBinary` | — | — | `api-remotes` | — | `fileUploads.upload` | on (but see below) |
| `hmr` | Dev-only hot reload over SSE | — | — | — | — | — | on in composition, **inert**: the hosted profile is pre-initialised and read-only (`OpenScience/CLAUDE.md`, runtime-dsh bullet) |
| `locale` | Language catalog, host-backed preference, fallback chain | — | `settings.general.item` | `connection`, `ui-renderer`, `ui-settings`, `api-remotes` | `settings.locale` | `settings` | on — **this is the surface our `zh-x-evimed` pack uses** (`packages/harness-port/src/runtimeUiShell.mjs:246-260`) |
| `ui-renderer` | Mounts the React app; owns the sole `renderSlot('root')` | `root` | — | — | — | — | on |
| `ui-session` | Session Controller ↔ React adapter; installs the `session` slot scope | — | — | `api-session-controller`, `ui-renderer` | — | `sessions` | on |
| `ui-settings` | Settings shell + the canonical settings slot contract | `settings.trigger`, `settings.header`, `settings.action`, `settings.close`, `settings.section`, `settings.plugins.tab`, `settings.onboarding`, `settings.general.item` | — | `api-remotes` | — | `settings` | on (kept deliberately: nine rows inject it — `dshProfilePatch.mjs:251-255`) |

### Shell / layout

| Package | What it renders | Declares | Occupies | Needs | Locale ns | Remote faces | State |
|---|---|---|---|---|---|---|---|
| `ui-layout` | The three-column AppFrame + drag handles + `ctx.layout` viewing-state service | `sidebar`, `main`, `rightbar`, `shell.overlay` | `root` | `locale`, `ui-renderer`, `ui-session`, `ui-theme` | — | `layout`, `theme.getTheme` | on |
| `ui-theme` | `--dsw-*` token stylesheet, ThemeRuntime, Appearance settings row | — | `settings.general.item` | `connection`, `locale`, `ui-renderer`, `ui-settings`, `api-remotes` | `settings.theme` | `theme.setTheme/setFontSize` | on |
| `ui-sidebar` | The left navigation column: session tree, search, grouping, state dots | `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.panellist`, `sidebar.workspaces`, `sidebar.settings`, `sidebar.footer.action` | `sidebar` | `api-workspace-controller`, `ui-renderer`, `ui-layout`, `ui-session`, `ui-workspace`, `locale` | — | `layout`, `slots` | on in the composition, **shadowed**: our shell registers `Nothing` into `sidebar` at priority `-1` and removes the column with CSS (`runtimeUiShell.mjs:237`, `:330`) |
| `ui-brand-official` | DeepSeek's whale mark + wordmark | — | `sidebar.brand.mark`, `sidebar.brand.name` | `ui-renderer`, `ui-sidebar` | — | — | **disabled** (`dshProfilePatch.mjs:311`) |
| `ui-workspace` | The WorkspacePicker in the sidebar and the hero empty state | `conversation.hero.workspace.directoryFlow`, `sidebar.workspaces.directoryFlow` | `conversation.hero.workspace`, `sidebar.workspaces` | 10 packages | — | `workspaces.*`, `directoryPicker.*`, `sessions.*` | on (cannot be disabled — three packages inject it, `dshProfilePatch.mjs:251-255`); the hero picker is shadowed by `Nothing` (`runtimeUiShell.mjs:243`) and `_heroWorkspaceRow` is hidden by CSS (`runtimeUiShell.mjs:302`) |
| `ui-directory-picker-browse` | In-app directory browsing | — | `conversation.hero.workspace.directoryFlow`, `sidebar.workspaces.directoryFlow` | `api-remotes`, `ui-renderer`, `ui-workspace`, `locale` | — | `directoryPicker.list/createDirectory` | **not-composed** (no row in the baseline; `directoryPicker/*` is a denied namespace — `runtimeUiSurface.mjs:62`, and see `dshProfilePatch.mjs:336-345`) |
| `ui-directory-picker-native` | Renderless driver for the OS chooser | — | same two | `ui-renderer`, `ui-workspace` | — | `directoryPicker.pick` | **not-composed** |

### Conversation core

| Package | What it renders | Declares | Occupies | Needs | Locale ns | Remote faces | State |
|---|---|---|---|---|---|---|---|
| `ui-conversation` | Target-neutral conversation assembly: shell, composer, queue, view navigation | **21 slots**: `main.conversation`, `conversation.session`, `.session.header`, `.header.lineage`, `.header.actions`, `.header.utilities`, `.header.corner`, `conversation.view`, `conversation.composer`, `conversation.hero.workspace`, `.hero.brand.mark`, `.hero.agentPreset`, `conversation.input.dock`, `.input.overlay`, `.composer.dock`, `.input.left`, `.input.right`, `.composer.bar`, `.input.attachments`, `.input.plan`, `.input.model` | `main`, `main.conversation`, `conversation.session`, `conversation.session.header`, `conversation.composer.bar`, `conversation.input.dock`, `settings.general.item` | `api-session-controller`, `file-upload`, `locale`, `ui-layout`, `ui-renderer`, `ui-session`, `ui-settings`, `ui-workspace` | — | `conversation.*`, `fileUploads`, `sessions` | on — **the richest extension surface we barely use** |
| `ui-chat` | The Chat conversation target: node definitions, renderers, the 「详情」 details surface | `conversation.chat.node`, `.chat.commandview`, `.chat.turnTail`, `.chat.assistant-actions`, `conversation.message.images` | `conversation.view`, `conversation.chat.node`, `conversation.composer.dock`, `conversation.approval.detail`, `settings.general.item` | 10 incl. `ui-sidebar-right` | — | `sessions.fork/open/binding`, `sidebarRight.openResource` | on |
| `ui-tool` | The tool call-tree renderer + the keyed per-tool presentation slot | `tool.call.toolview`, `tool.call.images` | `conversation.chat.node`, `tool.call.toolview` | `api-workspace-controller`, `connection`, `locale`, `ui-conversation` | — | — | on |
| `ui-attachment` | Attachment presentation in composer, message images, trajectory images, tool images | — | `conversation.input.attachments`, `conversation.message.images`, `conversation.trajectory.images`, `tool.call.images` | `ui-chat`, `ui-conversation`, `ui-renderer`, `ui-trajectory`, `ui-tool` | — | — | on |
| `ui-approval` | Approval composer takeover over the scoped Remote Event waterfall | `conversation.approval.detail` | `conversation.composer` | 6 | — | `sessions.scopeOf` | on — but approval policy is `never`/auto-refuse hosted (`OpenScience/CLAUDE.md`, Safety defaults), so it should never fire |
| `ui-user-questions` | `ask_user_question` composer takeover + plan-review presentation | — | `conversation.composer` | 6 | — | `sessions.scopeOf` | on |
| `ui-subagent` | Subagent catalogue, continuation routing, header lineage chip, `@` reference source | — | `conversation.composer`, `conversation.session.header.lineage` | `api-session-controller`, `locale`, `ui-conversation`, `ui-primitives`, `ui-input-trigger` | `subagent` | `sessions.openSubagent/refreshSubagents/setSubagentCatalogOpen` | on — this is the 「2 个子代理」 chip |
| `ui-workflow-run` | Durable workflow-run conversation node + nested member disclosure | — | `conversation.chat.node` | `api-session-controller`, `locale`, `ui-chat`, `ui-conversation`, `ui-renderer`, `ui-session` | — | `sessions.open` | on, but **unused**: nothing in our runtime emits a workflow run (see T2) |
| `ui-deliverables` | Produced-files turn tail + clickable file references in the final response | — | `conversation.chat.turnTail`, `tool.call.toolview` | `api-remotes`, `connection`, `locale`, `ui-chat`, `ui-conversation`, `ui-renderer`, `ui-tool` | `deliverables` | `deliverables/presented`, `workspaceFiles` | on in the composition, **dead in practice**: `workspaceFiles` is a denied namespace (`runtimeUiSurface.mjs:65,101`) and the deny-list comment says so explicitly (`runtimeUiSurface.mjs:95-100`) |
| `ui-trajectory` | Event ledger + interactive timing overview; registers into the conversation ViewMap | `conversation.trajectory.images` | `conversation.view` | `api-session-controller`, `locale`, `ui-conversation`, `ui-renderer`, `ui-session` | — | `sessions.binding`, `tools.*` | **operator-only** since 2026-09-16 (`dshProfilePatch.mjs:290-292`) — the owner's complaint #2 |
| `ui-goal` | GoalBar docked above the composer, read from the goal session projection | — | `conversation.chat.node`, `conversation.input.dock` | 7 | — | `goals.get/edit/pause/resume/clear` | **disabled** (`dshProfilePatch.mjs:310`); `goals` is also a denied namespace (`runtimeUiSurface.mjs:68`) |
| `ui-plan` | Plan-mode composer control over the plan projection + the `/plan` channel | — | `conversation.input.plan` | `api-remotes`, `locale`, `ui-conversation` | — | `commands.execute`, `plan/mode` | **on** — and unused by us (see T2) |
| `ui-jobs` | Session-header background-job list mirrored from `session/jobs` frames | — | `conversation.session.header.actions` | `locale`, `ui-conversation`, `ui-primitives` | `job` | (none — list mirror only) | **on** and unused |
| `ui-schedule` | Read-only active Schedule catalogue in the session header | — | `conversation.session.header.actions` | `locale`, `ui-conversation`, `ui-primitives` | `schedule.catalog` | — | **disabled in the base image itself** (`dump-config.baseline.json:529-531`), not by our patch |
| `ui-message-feedback` | Per-message Like/Dislike + the `/feedback` dialog | — | `conversation.chat.assistant-actions`, `conversation.input.overlay` | `api-remotes`, `locale`, `ui-conversation`, `ui-renderer`, `ui-commands` | — | `messageFeedback.*`, `sessionFeedback.record` | **disabled** (`dshProfilePatch.mjs:309`); both namespaces denied (`runtimeUiSurface.mjs:77,103`) |
| `ui-model-selection` | Model chip in the composer over the shared catalog | — | `conversation.input.model` | `api-session-controller`, `locale`, `ui-commands`, `api-remotes` | — | `sessions.selectModel` | **disabled** (`dshProfilePatch.mjs:305`); `session/selectModel` + `session/modelCatalog` also denied (`runtimeUiSurface.mjs:120-121`) |
| `ui-open-in-app` | Session-header "Open In…" split button | — | `conversation.session.header.utilities` | `locale`, `ui-conversation`, `ui-renderer`, `ui-session` | `open-in-app` | `session/openWorkspacePath` | **disabled** (`dshProfilePatch.mjs:325`); route prefix `/open-in-app/` also refused (`runtimeUiSurface.mjs:169-171`) |
| `ui-cordis` | The `cordis_define` tool row with its run/stop switch | `tool.view.cordis` | `tool.call.toolview`, `sidebar.footer.action` | 9 | — | `dynamicCordisRunner`, `cordis` | **disabled** (`dshProfilePatch.mjs:312`); both namespaces denied (`runtimeUiSurface.mjs:66,76`) |

### Right sidebar

| Package | What it renders | Declares | Occupies | Needs | Locale ns | Remote faces | State |
|---|---|---|---|---|---|---|---|
| `ui-sidebar-right` | The right docking surface: session-bound tab state, the panel, the header expand control, the navigation service | `rightbar.session`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`, `sidebar.right.tab.guide`, `sidebar.right.tab.menu.item` | `rightbar`, `rightbar.session`, `conversation.session.header.corner`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title` | `api-session-controller`, `resources`, `ui-conversation`, `ui-layout`, `ui-session` | — | `layout.openRightbar/closeRightbar`, `resources.pin` | on — kept because `ui-chat` injects it (`dshProfilePatch.mjs:320-323`) |
| `ui-sidebar-files` | Workspace file-tree **tab type** over the `workspaceFiles` remote namespace | — | `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title` | `api-workspace-files`, `ui-sidebar-right`, `ui-session`, `api-remotes` | — | `workspaceFiles.list` | **disabled** (`dshProfilePatch.mjs:326`) |
| `ui-sidebar-documentpreview` | Preview tab types: Markdown, highlighted code, images, PDF, HTML, plain text (6.6 MB bundle) | `sidebar.right.tab.document` | `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`, `sidebar.right.tab.document` | `api-gateway`, `api-workspace-files`, `ui-sidebar-right`, `ui-session`, `api-remotes` | `documentMarkdown`, `documentHtml`, `sidebarImage`, `sidebarPdf` | `workspaceFiles.read/readAll/readRelated` | **disabled** (`dshProfilePatch.mjs:327`) |

**This is complaint #1.** With both tab types disabled, `ui-sidebar-right` has no registered tab type at all, so the
panel shows only its own built-in start tab and 「新标签页」 opens nothing (`00-live-findings.md` F2).

### Composer input

| Package | What it renders | Declares | Occupies | Needs | Locale ns | Remote faces | State |
|---|---|---|---|---|---|---|---|
| `ui-input-trigger` | The `/` and `@` detection pipeline, candidate menu, pick routing to registered sources | — | `conversation.input.overlay` | `api-session-controller`, `locale`, `ui-conversation`, `ui-renderer` | `slash.menu` | `sessions.scope` | on |
| `ui-commands` | Command surface: global directory cache, the `/` source, three command UI kinds, `popupSelect` registry | — | `conversation.input.overlay` | `api-remotes`, `locale`, `ui-input-trigger`, `ui-conversation` | — | `commands.list/find/execute` | **on** — the native home for the fifteen capabilities (complaint #4) |
| `ui-reference` | The unified `@file` and `@session` reference source | — | — (source registration, not a slot) | `api-remotes`, `api-session-controller`, `connection`, `locale`, `ui-input-trigger` | — | — | on |
| `ui-skill` | Skill `@` references + the dedicated skill tool row | — | `tool.call.toolview` | 6 | — | `skills.list`, `sessions.subagentAddress` | on |

### Settings (all disabled hosted)

| Package | Declares | Occupies | Locale ns | State |
|---|---|---|---|---|
| `ui-settings-general` | — | `settings.trigger`, `settings.header`, `settings.action`, `settings.close`, `settings.section`, `sidebar.settings` | — | **disabled** (`dshProfilePatch.mjs:303`) |
| `ui-settings-models` | `settings.models.provider-card`, `settings.models.footer` | `settings.section`, `settings.onboarding` | `settings.models` | **disabled** |
| `ui-settings-plugins` | `settings.plugin.item` | `settings.section`, `settings.plugins.tab`, `settings.plugin.item` | `settings.plugins` | **disabled** |
| `ui-settings-plugin-inventory` | — | `settings.plugins.tab` | `settings.pluginInventory` | **disabled** |
| `ui-agent-preset` | — | `conversation.hero.agentPreset`, `conversation.session.header.actions`, `settings.section` | `settings.agentPreset` | **disabled** (`dshProfilePatch.mjs:308`) — this is why `conversation.hero.agentPreset` is an undeclared slot in our build (`runtimeUiShell.mjs:152-159`) |
| `ui-permission-presets` | — | `settings.general.item` | `settings.permission` | **disabled** as row `ui-permission` (`dshProfilePatch.mjs:299-307`) |

### What we occupy today

`packages/harness-port/src/runtimeUiShell.mjs` registers exactly six occupants, all cosmetic:

| Slot | Occupant | Priority | Line |
|---|---|---|---|
| `sidebar.brand.mark` | EviMed `Mark` | `-1` | `runtimeUiShell.mjs:233` |
| `sidebar.brand.name` | `Name` | `-1` | `runtimeUiShell.mjs:234` |
| `conversation.hero.brand.mark` | `Mark` | `-1` | `runtimeUiShell.mjs:236` |
| `sidebar` | `Nothing` | `-1` | `runtimeUiShell.mjs:237` |
| `conversation.input.dock` | `CapabilityDock` (`id: 'evimed-capabilities'`) | default | `runtimeUiShell.mjs:239` |
| `conversation.hero.workspace` | `Nothing` | `-1` | `runtimeUiShell.mjs:243` |

Plus a `zh-x-evimed` language with **four** overridden keys in **one** namespace (`conversation`)
(`runtimeUiShell.mjs:75-82`, `:102-109`) and a four-rule stylesheet (`runtimeUiShell.mjs:299-334`).

The socket's client bundle injects seven services (`packages/socket/package.json` → `dsh.client.inject`:
`api-session-controller`, `ui-conversation`, `connection`, `api-workspace-controller`, `ui-renderer`,
`ui-sidebar`, `locale`) and is emitted as one loader entry that runs `bridge` then `shell`
(`packages/socket/scripts/build-client.mjs:19-30`). **Adding a slot occupant is an edit to
`runtimeUiShell.mjs` plus, if it needs a new service, one line in `packages/socket/package.json`.**

### Slots nobody occupies in our build

From the declared set minus the occupied set, these seats are **empty and available** today:

`shell.overlay`, `sidebar.panellist`, `sidebar.settings`, `sidebar.footer.action`,
`conversation.session.header.utilities`, `conversation.session.header.actions` (ui-jobs only),
`conversation.input.left`, `conversation.input.right`, `conversation.input.plan` (ui-plan only),
`conversation.chat.commandview`, `conversation.chat.turnTail` (ui-deliverables only, and it is dead),
`conversation.chat.assistant-actions`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`,
`sidebar.right.tab.guide`, `sidebar.right.tab.menu.item`, `tool.call.toolview` (keyed — see T2).

---

## T1 — The right sidebar (complaint #1: "always blank, only an empty 「开始」 tab")

### What the panel is

`ui-sidebar-right` is a **docking surface**, not a panel with content. It owns three things and ships
almost no content of its own:

- `ctx.sidebarRight` — the navigation controller (`ui-sidebar-right/lib/types/client/service.d.ts`,
  described at `ui-sidebar-right/README.md:84-89`).
- `ctx.sidebarRightTabs` — the tab-type registry (`ui-sidebar-right/lib/types/client/tab-registry.d.ts:130-205`).
- One `SurfaceState` per session id, **memory-only**: "A reload returns every session to the collapsed
  default" (`ui-sidebar-right/README.md:70`, and again as a known limitation at `:121`).

The layout engine itself is `@deepseek-ai/dsh-client-ui-dockkit`, which is **not** in `/tmp/dshc`
(`ui-sidebar-right/README.md:34`). Split panes, drag, float/dock, drop zones all come from there.

### What 「开始」 is

It is the **guide tab** — a shipped tab type whose id is
`@deepseek-ai/dsh-client-ui-sidebar-right/guide` (`ui-sidebar-right/README.md:77`). Its title string is
`sidebarRight` / `tab.guide.title` = 「开始」
(`ui-sidebar-right/lib/client.js:3544`). 「新标签页」 is `sidebarRight` / `dock.addTab`
(`ui-sidebar-right/lib/client.js:3536`).

The guide's body is **entirely derived from other packages**:

> "The guide tab is a muted compass over one entry capsule per `guide` entry the registered types
> contributed, in `order`, centred in the body; **the guide has no words of its own**."
> — `ui-sidebar-right/README.md:101`

And the default-page rule:

> "Default pages depend on the number of registered guide entries, not the number of tab types or open
> tabs. Exactly one entry opens its page directly (Files in the shipped composition); zero or multiple
> entries open the guide." — `ui-sidebar-right/README.md:99`

**Therefore the blank panel is exactly what our composition asks for.** The only two packages that
contribute guide entries are `ui-sidebar-files` (one entry, `order: 10`,
`ui-sidebar-files/lib/client.js:35-40`) and — indirectly — nothing else;
`ui-sidebar-documentpreview` registers a resource type with **no `guide`**
(`ui-sidebar-documentpreview/lib/client.js:1766-1775`). Both are disabled
(`apps/server/src/dshProfilePatch.mjs:326-327`), so the registry has **zero guide entries**, the guide
opens, and it renders an empty compass. 「新标签页」 calls `openTab('guide', …)`
(`ui-sidebar-right/README.md:101`) — it opens the same empty guide, which is why it "opens nothing".

Also relevant: 「开始」 cannot be closed — "The sole docked guide is the only tab that cannot close"
(`ui-sidebar-right/README.md:99`). So the empty panel is not dismissable from inside the tab strip;
only the collapse control removes it.

A tab kind with no type in force renders the owner's notice
`sidebarRight` / `tab.unavailable` = 「这类内容还没有可用的查看方式。」
(`ui-sidebar-right/lib/client.js:3545`, contract at
`ui-sidebar-right/lib/types/client/contract/slots.d.ts:19-31`).

### The exact contract to register our own tab

Two stages, both inside the registering plugin's own `ctx.effect`
(`ui-sidebar-right/README.md:75-78`):

**Stage 1 — the type** (`ctx.sidebarRightTabs.register(definition)`,
`tab-registry.d.ts:153`, definition shape at `tab-registry.d.ts:68-109`):

```
{
  id: string,                       // unique across every registration; package name is the natural value
  kind: string,                     // what openTab(kind) names
  patterns?: readonly string[],     // globs over dsh-resource:// addresses; OMIT for a page type
  priority?: 'extension'|'builtin'|'fallback',   // default 'extension' — highest band
  canOpen?: (address: string) => boolean,
  title: (address: string) => string,            // thunked: re-read on every use, so a language switch needs no re-registration
  guide?: readonly { order: number, title: () => string, description?: () => string, icon?: ComponentType<IconProps> }[]
}
```

Returns an idempotent disposer. A second registration of an `id` throws; a `kind` carries at most one
`builtin` and one `extension` registration (`tab-registry.d.ts:140-152`).

**Stage 2 — the body** (`ui-sidebar-right/README.md:78`):

```
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)
```

Note the **`key`**, not `id` — this is a `keyed` slot
(`ui-sidebar-right/lib/types/client/contract/slots.d.ts:26-31`), unlike `conversation.input.dock`,
which is a list slot and needs `id` (the mistake already recorded at
`packages/harness-port/src/runtimeUiShell.mjs:155-159`).

The body reads `{ sidebar, panel, tab }` through the framework-injected `useTabInfo()`
(`contract/slots.d.ts:116-145`): `sidebar.expanded`/`sidebar.fullscreen`, `panel.id`, and
`tab` = the record + `visible` + `navigation` (`{ address, params, revision }`) + `signal`
(an `AbortSignal` aborted only on record removal or plugin unload) + `actions`
(`openResource`, `openTab`, `close` — `contract/slots.d.ts:96-115`).

Optional third registration: `{ name: 'sidebar.right.pane.tab.title', key: definition.id }` for a live
chip title; without it the chip shows `title(address)` captured at open time
(`contract/slots.d.ts:32-45`, limitation restated at `README.md:125`).

### Opening a tab programmatically

`ctx.sidebarRight` (`ui-sidebar-right/README.md:87-89`):

| Method | Purpose |
|---|---|
| `openResource(address, options?)` | `address` is a `dsh-resource://<type>/…` URI; the registry claims it by glob band unless `options.kind` names a type. `options` = `{ paneId?, revealIfOpened?, replaceTab?, params? }`. |
| `openTab(kind, options?)` | Opens a **page** type by kind; page tabs always deduplicate within the target pane. |
| `close(tabId)`, `active()`, `isExpanded()`, `toggleExpanded()` | |
| `focus(tabId)`, `split(paneId?)`, `float(tabId, rect?)`, `dock(paneId)` | Programmatic layout arrangement, each recorded as one history entry. |

Both opens **expand the panel** — "content the user cannot see is not opened"
(`README.md:87`). An unclaimed address or an unregistered kind **throws**: "that is a wiring mistake,
not a user error" (`README.md:87`). Commands require a mounted session surface.

`ui-chat` is the live caller: a file link or a tool row's line reference routes to
`ctx.sidebarRight.openResource(url)` / `openResource(url, { params: { line } })`
(`ui-chat/lib/client.js:8322-8323`).

### Session binding and persistence

- One surface per session id; switching sessions keeps each surface where it was
  (`README.md:62`, `:70`).
- **Nothing is persisted.** A reload starts every session collapsed and empty (`README.md:70`, `:121`).
- **No surface without a session** — "the hero screen shows nothing on the right" (`README.md:122`).
  So a blank-session right panel is impossible by design.
- The panel has no header row; its presentation switch and collapse button ride the tab strip
  (`README.md:48`). The expand button lives in `conversation.session.header.corner` and renders nothing
  while the panel is shown (`README.md:53`).
- Below 768 px the panel opens fullscreen automatically (`README.md:39`).
- Two horizontal panes maximum, divider 20 %–80 % (`README.md:101`).

### What re-enabling `ui-sidebar-files` + `ui-sidebar-documentpreview` would give

**`ui-sidebar-files`** (`ui-sidebar-files/README.md`):
- Registers kind `files`, id `@deepseek-ai/dsh-client-ui-sidebar-files`, band `builtin`, **no patterns**
  (a page type), and **one guide entry at `order: 10`** with a folder glyph
  (`ui-sidebar-files/lib/client.js:29-42`). With it re-enabled and nothing else, the registry has exactly
  one guide entry, so the panel **opens the file tree directly instead of the guide**
  (`ui-sidebar-right/README.md:99`).
- The root is `useSessions().byId[sessionId].cwd`. Each level is listed lazily through
  **`remote.workspaceFiles.list(sessionId, absolutePath)`** (`ui-sidebar-files/lib/client.js:50`).
- Rows: directories toggle; files call
  `tab.actions.openResource('dsh-resource://file/session/<sessionId>/<encoded relative path>')`;
  `other` entries are greyed.
- Limitations: **listing only** — no search, no artifact filter, no rename, no context menu, no current-file
  highlight, no watching; a level refreshes only on the reload control (`ui-sidebar-files/README.md`,
  Known Limitations).

**`ui-sidebar-documentpreview`** registers **one** tab type, not six:
`patterns: ["dsh-resource://file/**"]`, `priority: "fallback"`,
`canOpen: address => parseFileAddress(address)?.scope === "session"`
(`ui-sidebar-documentpreview/lib/client.js:1766-1775`, registered at `:26935`).
The Markdown / highlighted-code / image / PDF / HTML / plain-text renderers are **six occupants of the
keyed `sidebar.right.tab.document` slot that this same package declares**
(`ui-sidebar-documentpreview/lib/client.js:1361, 2177, 2462, 2657, 26728, 26906`; contract at
`lib/types/client/document/contract.d.ts:24-47`). Content is loaded by the tab owner through
`workspaceFiles.read` / `readAll` / `readRelated` and handed to the renderer as
`{ kind: 'text', text, pages, eof }` or `{ kind: 'bytes', data }`
(`document/contract.d.ts:15-22`). It is a **6.6 MB** bundle — by far the largest client package.

**The wire methods this needs, and the blocker.** Both packages talk to the
`workspaceFiles` remote namespace — `list` for the tree, `read`/`readAll`/`readRelated` for previews.
**`workspaceFiles` is a denied namespace in our hosted surface**
(`packages/domain/src/runtimeUiSurface.mjs:65` and `:101` — it is listed twice), for a documented
reason: 0.1.5's `workspaceFiles` "deliberately permits arbitrary absolute paths"
(`runtimeUiSurface.mjs:63-64`), and `read`/`readAll`/`readBytes`/`stat` resolve through `locateFile`
with the workspace only as *cwd*, never calling the `confine` helper — only `list` does
(`runtimeUiSurface.mjs:81-88`).

> **Load-bearing consequence:** `workspaceFiles/list` **is** confined; `read`/`readAll`/`readRelated` are
> **not**. So re-enabling the *file tree* alone needs only `workspaceFiles/list` allow-listed — a
> per-method exception inside an otherwise denied namespace, which the deny list already supports for
> `session/*` (`runtimeUiSurface.mjs:113-141`). Re-enabling *previews* requires the unconfined reads, and
> should not be done as-is.

### `ui-deliverables` — what it does and why it is dead here

`ui-deliverables` puts a produced-files row into `conversation.chat.turnTail` and links matching inline
code spans in the closing prose (`ui-deliverables/README.md`, Summary). How the kernel learns which
files a turn produced:

> "`deliverablesDefinition` folds each Turn's successful first-party mutation calls into
> `DeliverablesTurnData` from the validated raw arguments of **`write`, `edit`, and mutating
> `str_replace_editor` commands**. Reads, deletes, unsupported tools, malformed calls, and failed results
> contribute nothing. **A new mutation tool needs an explicit Client contribution before it joins the
> list.**" — `ui-deliverables/README.md`, Understand the implementation

There is a second, explicit path: the **`present` tool** (`files: [{ path, description? }]`), which the
Web `standard`, `ptc` and `cordis` presets expose, and which is the only way terminal-created files get
declared — "Terminal-created files require explicit delivery — call `present`"
(`ui-deliverables/README.md`, Known Limitations).

**Three independent reasons it produces nothing for us:**

1. **Our runs write through `bash`, not `write`/`edit`.** Measured on a finished 17-minute run: 106 `bash`
   calls vs 27 `write` and 6 `edit` (`00-live-findings.md` F5). Every file a python script writes is
   invisible to the fold.
2. **`present` is not mounted.** `KERNEL_MOUNTED_TOOL_NAMES` in
   `packages/domain/src/toolNames.mjs:235-245` lists `bash, read, write, edit, glob, grep, list, skill,
   task, fs_read, fs_write, fs_edit, fs_search, job_run, job_status, ask_user, subagent,
   subagent_control, subagent_report, workflow` — no `present`, and no `str_replace_editor`. Nothing
   named `present` appears in `deploy/runtime-dsh/dump-config.baseline.json`.
3. **Clicking a chip would go nowhere.** A chip opens the file "through the owner's `openFile`, which the
   chat view routes to the right Sidebar as a text-preview tab" (`ui-deliverables/README.md`, Use this
   package) → `ctx.sidebarRight.openResource` (`ui-chat/lib/client.js:8322`) → claimed by
   `ui-sidebar-documentpreview`, which is disabled. With no type in force the tab renders 「这类内容还没有可用的查看方式。」
   And `workspaceFiles.read` is denied anyway.

It also costs us a system-prompt section: "The Node half registers the static
`ui:deliverable-file-references` system-prompt section asking the model to mention primary files…"
at "first-party order 9000" (`ui-deliverables/README.md`). That paragraph is in every run's prefix today
and buys nothing, because the row it advertises never renders.

### T1 conclusions

| Option | What it takes | Verdict |
|---|---|---|
| Re-enable `ui-sidebar-files` only | Remove one row from `HOSTED_DISABLED_BROWSER_PANELS`; allow-list **`workspaceFiles/list`** as a per-method exception (the confined method) | Cheapest fix for the blank panel: one guide entry means the panel opens straight into the workspace tree. But every file click then throws into an unclaimed address unless a viewer exists. |
| Re-enable both | Also allow `workspaceFiles/read`, `readAll`, `readRelated` — **unconfined by upstream's own documentation** | Not as-is. Would need a control-plane-side scoped read, i.e. our own viewer type. |
| **Register our own tab type(s)** | `ctx.sidebarRightTabs.register` + a keyed `sidebar.right.pane.tab` body in `runtimeUiShell.mjs`, served by the control plane's existing scoped artifact APIs rather than `workspaceFiles` | The kernel-sanctioned path, and the only one that does not reopen the path-confinement hole. `priority: 'extension'` outranks every shipped viewer, and an extension may take over the `text` kind so the file tree's own clicks land in our viewer. |
| Contribute a `guide` entry | Any registered type may carry `guide: [{ order, title, description, icon }]` | Zero entries is what makes 「开始」 blank. One entry makes the panel open that page directly; two or more give a real compass. This is the switch, and it is free. |

Tab candidates that need no `workspaceFiles` at all: a **deliverables/交付物 tab** fed by our run ledger,
an **evidence-matrix tab**, a **claims/依据 tab** (`claimVerification` already exists in the domain).

---

## T2 — Progress and transparency surfaces (complaints #2 and #3)

The kernel ships **eight** surfaces that show what a run is doing. We show one and a half of them.

### `ui-trajectory` — what it shows, and whether it can be trimmed

The trajectory tab is "a turn-aware ledger and interactive timing overview. It groups User, Assistant,
Tool, nested Subtool, and compaction records, marks turn and step boundaries, and opens a record
inspector for token usage, duration, input, output, timing, images, and attachment summaries"
(`ui-trajectory/README.md`, Summary). The timing Overview "projects real record start/duration timing
from left to right; Assistant spans divide recorded TTFT from decoding"; dragging an interval focuses
the ledger; wheel zooms; right-drag pans (`ui-trajectory/README.md`, The timing overview).

**It is all-or-nothing.** The package:
- has **no `Config` schema** — no `Config` appears in any of its `lib/types/**/*.d.ts` (checked across all
  47 packages; only `connection`, `hmr`, `ui-conversation`, `ui-settings-models` and `ui-tool` have one);
- declares exactly one slot, `conversation.trajectory.images`
  (`ui-trajectory/lib/types/client/trajectory-contract.d.ts:13`);
- occupies exactly one slot, `conversation.view` (`ui-trajectory/lib/client.js`), as a **pure consumer**
  that "provides no service and declares no Context merge" (`README.md`, Layout);
- and explicitly owns the system-prompt row: "A complete appended prompt without a loaded request header
  appears as a standalone system row… In-history system prompt changes compare against the most recent
  request state" (`README.md`, Understand the implementation).

There is **no documented switch to hide system-prompt or raw-JSON rows inside the trajectory**. The
only granularity upstream offers is the view-ring registration itself, which is what
`OPERATOR_ONLY_BROWSER_PANELS` already toggles. **Confirmed: operator-only is the correct shape for
`ui-trajectory` as shipped.** Restoring it wholesale for researchers would restore the prompt exposure
the 2026-09-16 walk found (`apps/server/src/dshProfilePatch.mjs:275-288`).

But note what the row-disable did *not* have to take with it — the three surfaces below, which are
progress without prompt exposure.

### `ui-jobs` — what a "job" is, and why it is empty

A job is a **background shell process**: the header action reads "host-computed registry state through
the runtime's `jobsBySession` mirror and issues no RPC of its own"; the mirror is folded by the Session
Controller "from `session/jobs` frames" (`ui-jobs/README.md`, Summary + Understand the implementation).
The trigger appears "only when the session has at least one job, with a badge counting running and
stopping jobs". Rows show producer kind, label, status, and a live-ticking elapsed duration.

The producer is `dsh-tool-jobs` — "The model's own view of the same jobs belongs to `dsh-tool-jobs`;
this package is a read-only projection for the human" (`ui-jobs/README.md`, Summary). `job_run` and
`job_status` are in our mounted set (`packages/domain/src/toolNames.mjs:243`), and `tool-jobs` has a row
in the composition (`deploy/runtime-dsh/dump-config.baseline.json:154-156`).

**Why it is empty for us:** our runs call `bash` synchronously — 106 foreground bash calls in the
measured run, zero `job_run` (`00-live-findings.md` F5). Nothing ever populates `jobsBySession`.
`ui-jobs` is enabled, correct, and starved.

### `ui-plan` — plan mode, and whether `evimed_plan` could feed it

`ui-plan` renders **one chip**: "when the host-computed projection's effective target is plan mode, the
composer shows a warn-colored `Plan ×` button that turns plan mode off; otherwise the seat stays empty"
(`ui-plan/README.md`, Summary). It occupies `conversation.input.plan`, reads the `plan/mode` projection,
and its only verb is `exitPlanMode` → `ctx.remote.commands.execute('/plan off')`.

**It is not a plan display.** Plan mode itself belongs to `dsh-plan-mode` — which **is** in our
composition (`deploy/runtime-dsh/dump-config.baseline.json:202-203`, with a policy block at `:222`).
The model leaves plan mode through `exit_plan_mode`, and its plan review "uses the composed Web question
channel" — i.e. `ui-user-questions`' plan-review card.

**Could `evimed_plan` feed it? No, not as a plan *view*.** There is no slot for rendering a plan
document; there is a mode chip and a review card. Two things *are* reachable:
1. The `plan-review` **question intent** — "set by `dsh-plan-mode` on the `exit_plan_mode` review" —
   renders "a `Plan review` strip, the plan as the scrolling markdown body, and one decision row of
   `Chat about it` / `Refuse` / `Approve`" (`ui-user-questions/README.md`, The plan-review card). Any
   asker that sets that intent on an `ask_user_question` gets this card. Our `evimed_plan` could raise a
   plan-review question after planning and get a native, well-shaped plan presentation for free.
2. A **custom `tool.call.toolview` keyed on `evimed_plan`** — the general answer, below.

### `ui-goal` — GoalBar

Docked above the composer, "read from the goal session projection" (`ui-goal/README.md` description). It
reads `goals.get/edit/pause/resume/clear`. Disabled in our profile (`dshProfilePatch.mjs:310`) and
`goals` is a denied namespace (`runtimeUiSurface.mjs:68`) — "cross-day scheduling the control plane does
not know about" (`runtimeUiSurface.mjs:50`). The host-side producers `dsh-goal`, `dsh-goal-round-driver`,
`dsh-command-goal` and `tool-goal` *are* in the composition
(`dump-config.baseline.json:263-274, 327-329`), so the ban is the only thing stopping it. **Keep off** —
the run ledger is our goal store.

### `ui-workflow-run` — the closest native shape to a delegated deliverable

> "A top-level workflow run through `dsh-tool-workflow` appears in the conversation as its own node:
> expand the run to see its phases, and expand a phase to see its members."
> — `ui-workflow-run/README.md`, Use this package

Per-row detail: "a 32-pixel row with persistent chevrons, an inline state dot, and status text; phases
use disclosure rows with title and member count … members use a 16-pixel dot slot, a truncating name
area, and a fixed status column." Running/failed/cancelled/interrupted levels **open by default**;
completed levels stay closed.

It replays four durable session events: "`tool-workflow/run-start` creates one Context keyed by `runId`,
and member starts, member endings, and the run ending update that Context in log order"
(`README.md`, Understand the implementation).

**Could a delegated deliverable be one?** Structurally yes — run → phase → member maps onto
run → deliverable → child session almost exactly, and the node even opens a running member's child
session when `origin: 'subagent'` and `parentId` is the current session. **But not by us**: the record
only exists for "top-level calls through `dsh-tool-workflow`" — "nested PTC mode calls and direct
`WorkflowEngine` consumers do not" produce them (`README.md`, Known Limitations). Our delegation is
`evimed_delegate`, a socket tool. Adopting `ui-workflow-run` would mean routing delegation through the
kernel's `workflow` tool, which contradicts our delegation contract (deliverable ids, gate rounds,
`.evimed-run/state.json`). **It shows us the shape to copy, not the plugin to adopt.**

The node is also deliberately thin: "The node shows run, phase, member identity, and status only —
scripts, outputs, errors, logs, usage, static topology, and controls remain outside this surface."

### `ui-subagent` — what the parent transcript can and cannot show

What works today (`00-live-findings.md` F3 confirms the chip renders): the session header appends "a `/`
count trigger before the header's action row; the trigger opens the descendant catalog, counts the
complete subagent-only lineage, stops at ordinary forks, and shows ongoing activity when any counted
descendant is running" (`ui-subagent/README.md`, Use this package). Rows carry mode, `running`/`inactive`,
an optional log-backed title, and "the trailing column stacks total durable provider usage above
active-turn duration". Duration "advances once per second only for an open turn on a running child, and
freezes after the child becomes inactive" (`README.md`, Duration and tokens).

**Clicking a child opens that child's conversation** with its exact `{parentSessionId, childSessionId,
mode}` address — it *replaces the view*, it does not inline. There is no inline child-activity surface:
"The ordinary session sidebar omits subagent conversations, so the parent header catalog is their
navigation entry point."

**So: the parent transcript cannot show a child's live activity natively.** This is a hard upstream
limit, and it is the direct cause of complaint #3. Two further limits sharpen it:

- "The catalog has no durable outcome — activity and timing do not distinguish completion, failure, or
  cancellation" (`README.md`, Known Limitations).
- The turn-process summary's subagent count uses
  `isSubagentDelegationTool(name) => name === "subagent" || name.startsWith("subagent_")`
  (`ui-chat/lib/client.js:1434-1441`, consumed at `:6799-6803`). **`evimed_delegate` does not match**, so
  it is folded into the ordinary tool count, and 「{count} 个 subagent」 reads 0 for a delegated run
  (`ui-chat/lib/client.js:2682-2683`, rendered at `:3284`). The header chip that *does* work comes from
  `ui-subagent`'s own `subagentsByParent` mirror, not from this counter.

  > A one-line-cost fix exists at the *naming* level: a delegation tool named `subagent_delegate`
  > (or any `subagent_*`) would be counted correctly by the shipped code, with no plugin.

### `ui-tool` — the keyed per-tool presentation slot (the highest-leverage surface we do not use)

This is the general answer to "show progress inside the parent transcript". Exact contract
(`ui-tool/README.md`, Registering a business tool view, and
`ui-tool/lib/types/client/contract/slots.d.ts:6-47`):

```js
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({ name: 'tool.call.toolview', key: '<wire tool name>' }, BusinessToolRow))
```

- `kind: 'keyed'`, `scope: 'session'`.
- **The key domain is open** — "any wire tool name, including a tool your own package registered, so
  there is no compile-time key set to pick from and **a typo simply never renders**"
  (`contract/slots.d.ts:9-13`). MCP names work: the key is the *wire* name, so
  `mcp__evimed__literature_search` and `evimed_plan` / `evimed_delegate` /
  `evimed_submit_deliverable` are all valid keys.
- "A key the shipped composition already covers is **replaced, not shared**; an unclaimed key falls back
  to the generic tool row" (`contract/slots.d.ts:14-16`). So registering is additive for our tools and a
  takeover for `bash`/`read`/`write` if we ever want one.
- Owner props (`ToolCallOwnerProps`, `contract/slots.d.ts:59-88`):
  `callId`, `toolName`, `block`, `cwd?`, `home?`,
  `openFile(path, options?)`, `loadImage`, `inspect?` (opens the trajectory view — **should be absent /
  unused for a researcher build**).
- **Streaming / partial state** comes through `block`
  (`ui-conversation/lib/types/client/contract/records.d.ts:250-265`):
  - running: `RunningToolCall = { callId, parentCallId?, name, argsRaw, turn, step, time, subCalls }`
    — `argsRaw` is the **accumulating raw argument string**, so a view can render partial arguments
    while the model is still emitting them;
  - settled: `ToolResultNode = { kind:'tool-result', seq, time, callId, call: {name, argsRaw}|null,
    callTime, content, isError, error?, meta?, subCalls }`.
  - `subCalls` is recursive, and the tree renderer "sends the root and children at every depth through
    the same atomic dispatch path" (`ui-tool/README.md`, Rendering contract) — so a custom view for a
    nested call renders nested.
- The registration "receives the normal Session slot runtime share but no React node or Runtime service"
  (`ui-tool/README.md`) — i.e. a pure function of the frozen call.
- `ui-skill` is the shipped worked example of a business-owned registration (for the `skill` tool).

**This is the fix for "26分53秒 and nothing else".** A `tool.call.toolview` keyed on `evimed_delegate`
renders, in the parent transcript, whatever we can compute from `argsRaw` + our own control-plane data:
the deliverable id, its child session, elapsed time, gate rounds, files written. Same for `evimed_plan`
(render the three deliverables as a checklist) and `evimed_submit_deliverable` (render the verdict).

Caveat worth writing down: the view is a pure function of `block`, so anything beyond the call's own
arguments and result must arrive through a service the shell already injects — the socket's client
bundle can inject services (`packages/socket/package.json` → `dsh.client.inject`) and our frame already
has `__EVIMED_FRAME__` + a `postMessage` bridge to the shell
(`packages/harness-port/src/runtimeUiBridge.mjs:11-33`).

### `ui-chat` — the turn-process summary, custom node types, and the transcript mode

**Custom node types.** `conversation.chat.node` is keyed by `ChatNodeKind` and the semantics are explicit:

> "Reusing a key **replaces** that node renderer; **a kind with no occupant renders no row**."
> — `ui-chat/lib/types/client/contract/slots.d.ts:139-143`

The fourteen shipped keys (`ui-chat/lib/client.js:3689-3774`, `registerChatNodeRenderers`):
`user`, `steering`, `context`, `system-prompt`, `assistant-step`, `command`, `manual-compaction`,
`compaction`, `model-retry`, `turn-error`, `turn-max-tokens`, `turn-process`, `turn-tail`, `unknown`.

> **This is the documented, non-CSS way to hide 「系统提示词」 and 「上下文注入」 from researchers**:
> register a `conversation.chat.node` occupant under key `system-prompt` (and `context`) that returns
> `null`. It is a takeover of a shipped renderer through the public keyed-slot contract — the same
> mechanism `ui-skill` uses for `tool.call.toolview`. See T5 for the strings.

Note `conversation.chat.node` is declared as a **child slot of the `chat` `conversation.view`
registration** (`ui-chat/lib/client.js:8288-8305`), so an occupant must be registered after that view
exists — `ctx.slots.inject('conversation.chat.node', …)` handles the ordering.

**The `turnProcess` collapsed summary.** In Compact mode, at `turn/end` the turn's process rows collapse
behind one control that "reports Turn-wide durable counts for non-subagent Tool calls, reply-bearing
Assistant messages before the final answer, and subagent delegation calls; zero-valued segments are
omitted, the Tool and subagent figures are mutually exclusive, and neither System prompt nor Context
injection contributes a count. When all three counts are zero, the process still folds and the control
reads `Thought for a while`" (`ui-chat/README.md`, Turn Process Folding). The counting state is
`{ messageCount, toolCallCount, subagentCount }` (`ui-chat/lib/client.js:6743-6803`).

**Transcript Normal/Compact and how a host sets the default.**
- Settings namespace `ui-chat`, field `transcriptView`, values `["normal","compact"]`, default
  `"compact"` (`ui-chat/lib/client.js:8169-8176`).
- It is stored in the **Host user-settings document**, bound as
  `ctx.settingsScope.bind({ namespace: 'ui-chat' })` (`ui-chat/lib/client.js:8275`) and written with
  `host.set('transcriptView', mode)` (`:8200-8203`) — i.e. over the `settings/` wire namespace.
- The UI is one `settings.general.item` row, `id: 'transcript-view'`, `order: 12`
  (`ui-chat/lib/client.js:8276-8286`).
- **In our deployment that row is unreachable** (`ui-settings-general` is disabled,
  `dshProfilePatch.mjs:303`) and `settings` is a **denied namespace** (`runtimeUiSurface.mjs:59`), so a
  browser cannot write it. It therefore always resolves to the default, `compact`.
- A host *can* set it: it is an ordinary settings-document section, and `dshProfilePatch.mjs` already
  writes profile content. Whether the patch reaches this particular document is **not determinable from
  the client packages** — it needs a read of the host's settings-document layout, which is not in
  `/tmp/dshc`.

**`conversation.chat.turnTail`** — kind `chain`, scope `session`, owner `TurnTailOwnerProps`
(`ui-chat/lib/types/client/contract/slots.d.ts:176-185`): "Selector-routed extension before a completed
Turn's action row. The component receives the Turn, closing sequence, and file opener. The first selector
that accepts the owner renders; an all-declined chain is empty." Today only `ui-deliverables` registers
here, and it never produces anything (T1). **A free seat for a per-turn 「本轮交付」 summary of our own.**

**`conversation.chat.assistant-actions`** — kind `list`, "a fresh `id` adds an action and reusing one
replaces that entry" (`contract/slots.d.ts:186-195`). Only `ui-message-feedback` used it, and that row is
disabled — so this is an empty list slot for e.g. 「查看依据」 / 「导出」.

**`StatsPills`** — the end-of-turn statistics line is registered into `conversation.composer.dock`,
`id: 'stats'`, `order: 0` (`ui-chat/lib/client.js:8350-8355`). A single named entry in a list slot, so it
can be shadowed or complemented by `id`.

### `ui-schedule` and `ui-user-questions`

`ui-schedule` is "a read-only catalog of the current Session's active Schedule reminders in the Web
header. It reads the complete `schedule` projection and issues no RPC" (`ui-schedule/README.md`). It is
**disabled in the shipped Web graph itself** — "The shipped Web bundle keeps the plugin disabled until
the explicit Schedule overlay enables both the Host Schedule services and this client row"
(`ui-schedule/README.md`, Summary; our copy at
`deploy/runtime-dsh/dump-config.baseline.json:529-531`). Enabling it would need `@deepseek-ai/dsh-schedule`
host-side too. Our autopilot agendas are the equivalent, in the control plane. **Keep off.**

`ui-user-questions` drives `ask_user_question`: the composer is replaced by a question surface with
pager, single/multi select, custom answers, skip, and one structured submit batch
(`ui-user-questions/README.md`, Use this package). `ask_user` is in our mounted tool set
(`packages/domain/src/toolNames.mjs:244`) and the host row `user-questions` is composed
(`dump-config.baseline.json:38-39`). **This is live and correct**, and the `plan-review` intent path
described above is its most interesting unused capability. Drafts survive session navigation for the
page's lifetime; closing rejects the whole wait as `ASK_CANCELLED`.

### T2 summary

| Surface | Producer in our runtime? | Renders today? | Why |
|---|---|---|---|
| `ui-trajectory` | yes (every run) | operator only | deliberate; no finer switch exists |
| `ui-jobs` | `job_run` mounted, never called | no | our bash calls are foreground |
| `ui-plan` | `dsh-plan-mode` composed | chip only, never on | we never enter plan mode |
| `ui-goal` | host goal plugins composed | no | disabled + `goals` namespace denied |
| `ui-workflow-run` | `workflow` mounted, never called | no | we delegate with `evimed_delegate` |
| `ui-subagent` | yes — real child sessions | **yes**, header chip + catalogue | the one live progress surface |
| `ui-tool` keyed views | every tool call | generic card only | **we have registered none** |
| `ui-deliverables` | `write`/`edit` only | no | our writes go through `bash`; `present` unmounted |
| `ui-user-questions` | `ask_user` mounted | yes when asked | plan-review intent unused |

---

## T3 — Theming (`dsh-client-ui-theme`)

Path shorthand as in Section 0. `ui-theme/lib/client.js` is a bundle whose six stylesheets are each a
**single-line string literal**, so sub-line offsets cannot be cited; the line map is:

| Sheet | Line | Blocks, in source order |
|---|---|---|
| `base.css` | `ui-theme/lib/client.js:1047` | `:root{}` — font stacks + easing |
| `corner-shape.css` | `ui-theme/lib/client.js:1050` | `@supports{:root{}}` |
| `design-platform.css` | `ui-theme/lib/client.js:1053` | `body{static-light}` → `body[data-ds-dark-theme]{static-dark}` → `body{alias+specific-light}` → `body[data-ds-dark-theme]{alias+specific-dark}` |
| `scrollbar.css` | `ui-theme/lib/client.js:1056` | `body{}` + `::-webkit-scrollbar*` |
| `gradient-shadow-text.css` | `ui-theme/lib/client.js:1059` | gradients/shadows → `body,body *{elevation}` → dark gradients → the font ladder |
| `shiki.css` | `ui-theme/lib/client.js:1062` | `:root{}` + dark override |

They are injected as `<style data-plugin="@deepseek-ai/dsh-client-ui-theme">` for exactly the plugin
lifetime (`ui-theme/lib/client.js:1078-1090`); the manifest array is at `:1066-1073`.

### 1. The token table

#### 1a. `--dsw-static-*` — the raw ramp (73 tokens), `ui-theme/lib/client.js:1053`

**Identical in light and dark for 72 of 73.** The one exception is `--dsw-static-neutral-bluish-60`
(`#f5f6f7` light → `#f9fafb` dark).

| Token | Value | Token | Value |
|---|---|---|---|
| `amber-100` | `#fef5e7` | `neutral-00` | `#fff` |
| `amber-400` | `#f7ad31` | `neutral-50` | `#fafafa` |
| `amber-500` | `#f59e0b` | `neutral-100` | `#f5f5f5` |
| `amber-600` | `#dd8629` | `neutral-150` | `#ededed` |
| `amber-900` | `#27241f` | `neutral-200` | `#e5e5e5` |
| `blue-50` | `#eff6ff` | `neutral-250` | `#dcdcdc` |
| `blue-50p` | `#eaf3ff` | `neutral-300` | `#d4d4d4` |
| `blue-75` | `#e5f0ff` | `neutral-400` | `#a2a4a6` |
| `blue-100` | `#dbeafe` | `neutral-500` | `#7f8287` |
| `blue-300` | `#93c5fd` | `neutral-550` | `#65676b` |
| `blue-400` | `#60a5fa` | `neutral-600` | `#545557` |
| `blue-450` | `#4d93f8` | `neutral-700` | `#3c3c3d` |
| `blue-500` | `#3b82f6` | `neutral-800` | `#292929` |
| `blue-600` | `#2563eb` | `neutral-850` | `#212123` |
| `blue-800` | `#1e40af` | `neutral-900` | `#0f0f0f` |
| `blue-900` | `#0e3074` | `neutral-1000` | `#000` |
| `blue-950` | `#172554` | `neutral-bluish-00` | `#fff` |
| **`deepseek-50`** | **`#edf3fe`** | `neutral-bluish-50` | `#f9fafb` |
| `deepseek-100` | `#e4edfd` | **`neutral-bluish-60`** | **`#f5f6f7` / `#f9fafb`** |
| `deepseek-200` | `#d3e2ff` | `neutral-bluish-75` | `#f1f3f5` |
| `deepseek-300` | `#b7c8fe` | `neutral-bluish-100` | `#ebeef2` |
| `deepseek-400` | `#679efe` | `neutral-bluish-150` | `#e9ecf2` |
| `deepseek-450` | `#5686fe` | `neutral-bluish-200` | `#e1e5ee` |
| **`deepseek-500`** | **`#4176e6`** | `neutral-bluish-300` | `#cfd3d6` |
| `deepseek-600` | `#4868b2` | `neutral-bluish-400` | `#adb2b8` |
| `deepseek-700-delete` | `#2f4c8f` | `neutral-bluish-500` | `#979da6` |
| `deepseek-800` | `#34415b` | `neutral-bluish-600` | `#81858c` |
| `deepseek-900` | `#283142` | `neutral-bluish-700` | `#61666b` |
| `green-100` | `#e6faed` | `neutral-bluish-750` | `#43454a` |
| `green-400` | `#4ed17e` | `neutral-bluish-800` | `#353638` |
| `green-500` | `#22c55e` | `neutral-bluish-850` | `#2c2c2e` |
| `green-900` | `#233c2c` | `neutral-bluish-875` | `#232324` |
| `red-50` | `#fef2f2` | `neutral-bluish-900` | `#1b1b1c` |
| `red-100` | `#fee2e2` | `neutral-bluish-950` | `#151517` |
| `red-400` | `#f25a5a` | `neutral-bluish-1000` | `#0f1115` |
| `red-500` | `#ef4444` | | |
| `red-600` | `#ec1313` | | |
| `red-900` | `#570c0c` | | |

`--dsw-static-deepseek-500 = #4176e6 = rgb(65,118,230)` and `--dsw-static-deepseek-50 = #edf3fe =
rgb(237,243,254)` — **exactly the two values measured in production** (`00-live-findings.md` F7). The
whole DeepSeek identity is this one six-step ramp.

#### 1b. `--dsw-alias-*` — semantic layer (79 tokens), `ui-theme/lib/client.js:1053`

`nb-` = `--dsw-static-neutral-bluish-`, `ds-` = `--dsw-static-deepseek-`, `n-` = `--dsw-static-neutral-`.

**Surface** — `bg-base` `nb-00`→`nb-950`; `bg-layer-1` `nb-00`→`nb-875`; `bg-layer-2` `nb-00`→`nb-850`;
`bg-layer-3` `nb-00`→`nb-800`; `bg-mask-1` `#0000003d`→`#00000080`; `bg-mask-2` `#0000001f`→`#0003`;
`bg-mask-3` `#0000007a` both; `bg-mask-photo` `#000000e0` both; `bg-mask-drop` `#ffffffb3`→`#272730b3`;
`bg-module-platform` `nb-60`→`nb-800`; `bg-multi-select` `nb-60`→`n-850`; `bg-overlay` `nb-150`→`nb-700`;
`bg-skeleton` `#0000000a`→`#ffffff14`.

**Border** — `border-l1` `#0000000a`→`#ffffff0f`; `border-l2` `#0000001a`→`#ffffff1f` (standard hairline);
`border-l2-darkmode-thin` `#0000001a`→`#ffffff0f`; `border-l3` `#0000001f`→`#ffffff29` (sidebar rule);
`border-l4` `#00000029`→`#fff3` (backs `--dsw-elevation-stroke-color`); `border-inverted` `#0000`→`#ffffff0f`;
`border-inverted2` `#0000`→`#ffffff14`.

**Brand — NOT the accent.** `brand-primary` `nb-1000` (`#0f1115`) → `nb-50` (`#f9fafb`); `brand-primary-invert`
same; `brand-text` same; `brand-primary-new-colorprimary-new-color` `#4176e6`→`ds-450` (a Figma-export
artefact name that is the actual new brand blue).

**Button** — `button-contrast-fill` `nb-700`→`nb-50`; `button-elevated-fill` `nb-00`→`nb-750`;
`button-floating-fill` `nb-00`→`nb-850`; `button-floating-hover` `nb-75`→`nb-800`;
`button-ghost-active-border` `nb-500`→`nb-600`; `button-ghost-active-fill` `nb-100`→`nb-750`;
`button-ghost-active-hover` `nb-150`→`nb-700`; **`button-info-fill` `ds-500`→`ds-400` (the send button)**;
`button-info-hover` `ds-400`→`ds-500`; `button-primary-fill` = `var(--dsw-alias-brand-primary)`;
`button-primary-hover` `nb-750`→`nb-100`; `button-primary-dimmed` `nb-100`→`nb-750`;
`button-tool-bar-fill` `#54555780`; `button-tool-bar-fill-invisible` `#1f1f1f5c`; `button-tool-bar-hover` `#54555799`.

**Interactive** — `interactive-bg-hover` `#2631480f`→`#ffffff14` (91 uses); `interactive-bg-active`
`#2631481a`→`#ffffff24`; `interactive-bg-hover-accent` `#26314824`→`#ffffff3d`; `interactive-bg-hover-danger`
`#ec13130d`→`#f25a5a26`; `interactive-bg-hover-solid` `nb-75`→`nb-800`.

**Text** — `label-primary` `nb-1000`→`nb-50` (191 uses; also `--shiki-foreground`); `label-secondary`
`nb-700`→`nb-300`; `label-tertiary` `nb-600`→`nb-400` (**196 uses — the most-used token**);
`label-caption` `nb-400`→`nb-600`; `label-dimmed` `nb-200`→`nb-750`; `label-primary-dimmed` `nb-950`→`nb-100`;
`label-primary-foreground` `nb-00`→`nb-1000`; `label-primary-inverted` `nb-00`→`nb-800`;
`label-primary-bluish` `blue-900`→`nb-50`; **`link` `ds-500`→`ds-400`**.

**Markdown** — `markdown-code-block` `nb-50`→`nb-900` (also `--shiki-background`); `markdown-code-block-banner`
`nb-50`→`nb-850`; `markdown-code-segment-selected` `nb-00`→`nb-800`; `markdown-code-segment-unselected`
`nb-75`→`nb-900`; `markdown-inline-code` `n-50`→`n-800`; `markdown-citation` `nb-100`→`nb-800`;
`markdown-placeholder` `nb-60`→`nb-850`; `markdown-tag` `nb-75`→`nb-850`.

**Scrollbar** (only consumer is `scrollbar.css`, `:1056`) — `scrollbar-bg-l1` `n-200`→`n-700`;
`scrollbar-hover-l1` `n-300`→`n-600`; `scrollbar-bg-l2` `n-200`→`n-600`; `scrollbar-hover-l2` `n-300`→`n-550`.

**State** — **`state-business-primary` `ds-500`→`ds-400` (the most common focus ring)**;
`state-business-tertiary` `ds-100`→`ds-800`; `state-error-primary` `red-600`→`red-400` (73 uses);
`state-error-secondary` `red-400`; `state-success-primary` `green-500`; `state-success-secondary` `green-400`;
`state-success-tertiary` `green-100`→`green-900`; `state-warn-primary` `amber-500`; `state-warn-secondary`
`amber-400`; `state-warn-tertiary` `amber-100`→`amber-900`; `state-warn-label` `amber-600`.

**Chrome** — `toast-bg` `nb-800`→`nb-750`; `tooltip-bg` `nb-850`→`nb-750`.

#### 1c. `--dsw-specific-*` — component-pinned (11 tokens), `ui-theme/lib/client.js:1053`

| Token | Light | Dark | Drives |
|---|---|---|---|
| **`specific-bubble`** | **`ds-50` (`#edf3fe`)** | `nb-850` | **user message bubble** |
| `specific-bubble-highlight` | `ds-200` | `nb-750` | bubble highlight |
| `specific-input-major` | `nb-00` | `nb-850` | composer / file-card fill |
| `specific-login-input` | `nb-50` | `nb-900` | login input |
| `specific-menu` | `var(--dsw-alias-bg-layer-3)` | same | dropdown surface |
| `specific-selector` | `nb-60` | `nb-800` | segmented selector track |
| `specific-sidebar-fill` | `nb-50` | `nb-900` | sidebar column |
| `specific-sidebar-nav-item-active` | `nb-100` | `nb-750` | active nav item |
| `specific-sidebar-nav-item-active-accent` | `ds-100` | `nb-800` | active nav accent |
| `specific-sidebar-nav-item-hover` | `nb-75` | `nb-850` | nav hover |
| `specific-tip` | `nb-60` | `nb-800` | inline tip banner |

#### 1d. Fonts, easing, corners

| Token | Value | Where |
|---|---|---|
| **`--dsw-font-family`** | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif` | `ui-theme/lib/client.js:1047` — matches the measured production stack |
| `--ds-font-family-code` | `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"` | `:1047` (note `--ds-`, not `--dsw-`) |
| `--ds-ease-in-out` | `cubic-bezier(.4,0,.2,1)` | `:1047` |
| `--ds-transition-duration` / `-fast` / `-slow` | `.2s` / `.1s` / `.3s` | `:1047` |
| `--dsw-corner-shape` | `superellipse(1.5)` inside `@supports` | `:1050` |

> **There is no radius, spacing or z-index token family.** `--dsw-corner-shape` is the only geometry
> token; every `border-radius`, padding, gap and `z-index` is a hard-coded literal in the owning
> component's CSS module. This is the single biggest constraint on re-skinning.

#### 1e. Shadow / elevation / gradient, `ui-theme/lib/client.js:1059`

`--dsw-shadow-lv1` `0 2px 4px 0 #0000000d`; `-lv1-blur` `0 4px 12px 0 #00000005`;
`-lv2` `0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a`;
`-lv3` `0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014`;
`--dsw-elevation-stroke-color` = `var(--dsw-alias-border-l4)` (**rebindable per surface** — declared on
`body, body *`); `--dsw-elevation-stroke` `0 0 0 .5px var(--dsw-elevation-stroke-color)`;
`--dsw-elevation-panel`, `-prominent`, `-soft`; `--dsw-mask-blur` `blur(2px)`;
`--dsw-linear-gradient-think` and `--dsw-linear-think-select` (**declared but consumed by no shipped
package**). The shadow scale has **no dark override** — only the stroke colour adapts.

#### 1f. The font ladder — 30 scales × 6 tokens, `ui-theme/lib/client.js:1059`

Each scale `X` ships `--dsw-font-X` plus `-font-family/-size/-weight/-style/-line-height`, mode-invariant.
The `markdown-*` family is **elastic** (keyed off `--dsh-content-font-size`); the `xl/l/m/base/s/xs/xxs/xxxs`
family is **fixed**. Δ = `calc(var(--dsh-content-font-size,14px) - 14px)`.

`markdown-h1` `700 calc(21px+Δ)/calc(30px+Δ)` · `markdown-h2` `700 calc(19px+Δ)/calc(28px+Δ)` ·
`markdown-h3` `700 calc(18px+Δ)/calc(26px+Δ)` · `markdown-h4` `600 size/calc(24px+Δ)` ·
`markdown-base` `size/calc(24px+Δ)` (+`-strong`, `-italic`, `-strong-italic`) ·
`markdown-table` `secondary/calc(22px+Δ₂)` (+`-head` `500`) ·
`markdown-small` `12px/20px` (+3 variants) · `markdown-code` `12px/19px` ·
`markdown-code-block` `11px/19px` · `markdown-code-block-small` `11px/16px` ·
`xl-24` `600 24px/32px` · `l-20` `500 20px/28px` · `m-18` `500 16px/28px` *(name says 18, value is 16)* ·
`base-16` `16px/24px` (+`-strong`) · **`s-14` `14px/22px`** (+`-strong`) · `xs-13` `13px/20px` (+`-strong`) ·
`xxs-12` `12px/18px` (+`-strong`) · `xxxs-11` `11px/14px` (+`-strong`).

#### 1g. Derived `--dsh-*` axes (theme-owned, not `--dsw-`)

`--dsh-content-font-size` (12–17 px, set by the boot script / `ThemePresenter` —
`ui-theme/lib/index.js:47`, `ui-layout/lib/client.js:472`);
`--dsh-content-font-delta` = `calc(size - 14px)`;
`--dsh-content-font-size-secondary` = `min(calc(size - 1px), max(13px, calc(size - 2px)))`;
`--dsh-content-font-delta-secondary` = `calc(secondary - 13px)` — all `ui-theme/lib/client.js:1059`;
`--dsh-scrollbar-thumb/-hover/-width` (`:1056`).

#### 1h. Dangling tokens (consumed, never declared)

`--dsw-font` (5 uses, all with fallbacks); `--dsw-font-mono` (with fallbacks in `ui-sidebar-documentpreview`
and `ui-agent-preset`, but **without one** at `ui-jobs/lib/client.js:11` — that rule is dead);
`--dsw-alias-label-error` (5 consumers, never declared).

### 2. "Host bootstrap for the pre-plugin palette" — the phrase is a misnomer

The `package.json` description (`ui-theme/package.json:3`) promises a palette. **The artefact carries two
scalars.** The Node half hooks the webserver index render and pushes one inline `<script>`
(`ui-theme/lib/index.js:86-94`, row shape at `:57-63`, placed in `body` before the shell mount —
`ui-theme/lib/types/boot-theme.d.ts:9-16`). The generated body (`ui-theme/lib/index.js:38-49`) sets
exactly three things: `document.documentElement.style.colorScheme`, the body attribute
**`data-ds-dark-theme`**, and the body custom property **`--dsh-content-font-size`**.
`ThemePresenter` re-asserts the same three later (`ui-layout/lib/client.js:443-445`).

- **Global / bootstrap object: none.** No `window.__DSH_THEME__`, no JSON blob. The values are
  string-interpolated at render time — there is no reusable extension point.
- **Storage key: none.** No `localStorage`/`sessionStorage`/cookie anywhere in the theme bundle.
- **Durable source:** the Host settings document, namespace `"ui-theme"` (`ui-theme/lib/index.js:11`),
  read at `:74-78`, defaulting to `{preference:"system", fontSize:14}` at `:70-73`; the local provider
  persists it in `$DSH_HOME/settings.yaml` (`ui-theme/README.md:12`).
- **Schema (`ui-theme/lib/index.js:25-28`, registered at `:88`, mirrored client-side at
  `ui-theme/lib/client.js:904-907`):**

  ```js
  z.object({
    preference: z.union(["light","dark","system"]).default("system"),
    fontSize:   z.number().step(1).min(12).max(17).default(14)
  })
  ```

**A deployment cannot supply its own palette, accent, fonts or radii this way.** Mode and content font
size only.

### 3. ThemeRuntime

`ctx.theme: ThemeRuntime` (declared `ui-theme/lib/types/client/index.d.ts:84-87`, provided
`ui-theme/lib/client.js:1472`, class at `:1235-1410`).

| Method | Behaviour |
|---|---|
| `getTheme() → ThemeSnapshot` | frozen snapshot, stable reference until change (`:1280-1282`) |
| `setTheme(id)` | unknown ids throw; **persists only if `isThemePreference(id)`** (`:1299-1305`) |
| `setFontSize(px)` | throws unless integer 12–17; persists (`:1312-1318`) |
| `register(def) → dispose` | third-party theme id; duplicate or `"system"` throws; disposing while active resets preference to `"system"` (`:1336-1347`) |
| **`overrideTokens(source, tokens) → dispose`** | **stacks a token layer; one layer per `source`; later `seq` wins per token** (`:1364-1376`) |
| `exportInspectTokens()` | token directory, no DOM reads (`:1287-1292`) |

`ThemeSnapshot = { preference, fontSize, active, themes, revision }`, frozen
(`ui-theme/lib/types/client/index.d.ts:55-70`, built at `ui-theme/lib/client.js:1382-1388`).
`system` resolves at snapshot-build time from `matchMedia("(prefers-color-scheme: dark)")`
(constructed `:1256`, resolved `:1378`, `change` listener republishes **only while preference is
`system`** `:1258-1270`).

**Persistence is a Host settings scope**, not localStorage: `ctx.settingsScope.bind({ namespace:
'ui-theme' })` (`ui-theme/lib/client.js:1471`) → `remote.settings.mutate(...)`
(`ui-settings/lib/client.js:1045`).

> **Critical for a hosted iframe:** `const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"`
> (`ui-settings/lib/client.js:1345`). **A non-loopback page — ours — gets a memory-only scope**, so a
> user's theme and font-size choices are process-local and lost on reload. The README says as much:
> "Non-loopback pages keep both choices process-local" (`ui-theme/README.md:32`). Our
> `settings` namespace ban makes this moot in practice.

`ThemeRuntime` never touches the DOM (`ui-theme/lib/types/client/index.d.ts:1-9`). `ui-layout`'s
`ThemePresenter` does, on every `theme/change` (`ui-layout/lib/client.js:557-567`): sets
`html{color-scheme}`, toggles `body[data-ds-dark-theme]`, sets `--dsh-content-font-size`, writes
`active.tokens` as **inline custom properties on `body`**, and updates `meta[name=theme-color]`
(`ui-layout/lib/client.js:466-481`). It retracts only what it wrote
(`ui-layout/lib/types/client/theme-presenter.d.ts:8-9`).

**Can the embedding page drive it? No.**

| Channel | Present? | Evidence |
|---|---|---|
| `postMessage` listener | **no** | grep over all `/tmp/dshc/**/client.js` hits only `file-upload/lib/client.js:80-272` (upload worker) and `ui-sidebar-documentpreview/lib/client.js:10174` (preview sandbox) — zero in `ui-theme`/`ui-layout` |
| query parameter | **no** | no `URLSearchParams`/`location.search` in `ui-theme/lib/client.js` |
| storage key | **no** | no storage API in `ui-theme/lib/client.js` |
| bootstrap field | host-side only | rendered by the Node half from `$DSH_HOME/settings.yaml` |
| `prefers-color-scheme` | **yes, but not parent-controllable** | `ui-theme/lib/client.js:1256`; the iframe reads the OS/browser setting. Setting `color-scheme` on the `<iframe>` element changes UA chrome defaults, not the media-query result. |
| direct `ctx.theme` call | **no** | cross-origin frame; only `ui-layout` injects `"theme"` (`ui-layout/lib/client.js:498`) |

### 4. Appearance settings row

Two rows in `settings.general.item`: `id: "appearance"`, `order: 10`
(`ui-theme/lib/client.js:1493-1500`) and `id: "font-size"`, `order: 11` (`:1508-1515`).
Appearance is three mutually-exclusive cubes — Light / Dark / System, glyphs at `:52-68`, rendered as
`<button aria-pressed>` (`:83-91`) — and selection follows the **persisted preference, never the resolved
active theme** (`:75`). Font size is a stepper, integers 12–17, bounds-disabled (`:981`, `:990`).
Both mirror the snapshot through revision-guarded stores (`:1015-1027`, `:1032-1044`).

Locale namespace `settings.theme` (`ui-theme/lib/client.js:1121`, registered `:1473-1476`);
zh is the key-set source of truth and en is checked complete against it
(`ui-theme/lib/types/client/locales.d.ts:2`, `:16`):

| Key | en | zh |
|---|---|---|
| `appearance.title` | Appearance | 外观 |
| `appearance.light` / `.dark` / `.system` | Light / Dark / System | 浅色 / 深色 / 跟随系统 |
| `fontSize.title` | Font size | 字号大小 |
| `fontSize.description` | Only affects conversation content | 仅影响会话内容的字号 |
| `fontSize.unit` | px | px |
| `fontSize.increase` / `.decrease` | Increase / Decrease font size | 增大字号 / 减小字号 |

**Both rows are unreachable in our deployment** — `ui-settings-general` is disabled
(`apps/server/src/dshProfilePatch.mjs:303`).

### 5. What drives what

| Element | Rule | Token chain | Value |
|---|---|---|---|
| **User bubble bg** | `.Sixlwa_bubble{background:var(--dsw-specific-bubble)}` — `ui-chat/lib/client.js:155` | `specific-bubble` → `deepseek-50` | `#edf3fe` ✓ measured |
| **Send button** | `.uV2eYG_primary{background:var(--dsw-alias-button-info-fill);color:#fff;border-radius:999px;width:34px;height:34px}` — `ui-conversation/lib/client.js:15757` | `button-info-fill` → `deepseek-500` | `#4176e6` ✓ measured. **The glyph colour `#fff` and the `999px` radius are hard-coded literals, not tokens.** |
| **Links** | `color:var(--dsw-alias-link)` — `ui-deliverables/lib/client.js:170,489,593`; `ui-workflow-run/lib/client.js:12` | `link` → `ds-500`/`ds-400` | `#4176e6` / `#679efe` |
| **「深度求索中…」 shimmer** | `.EvIC1a_turnStatus{background:linear-gradient(90deg, var(--dsw-static-deepseek-500) 0%, … var(--dsw-static-deepseek-200) 50%, …);background-clip:text;animation:1.8s linear infinite}` — `ui-chat/lib/client.js:1508` | **consumes the static ramp directly, bypassing the alias layer** | `#4176e6` / `#d3e2ff` |
| Loading spinner | `border-top-color:var(--dsw-alias-state-business-primary)` — `ui-trajectory/lib/client.js:3661` | → `deepseek-500` | `#4176e6` |
| **Focus ring** | **not centralised — no single token.** Most common `outline:Npx solid var(--dsw-alias-state-business-primary)` (`ui-trajectory/lib/client.js:3661,6093`; `ui-cordis/lib/client.js:211`; `ui-chat/lib/client.js:1626`; `ui-workflow-run/lib/client.js:12`; `ui-settings-plugin-inventory/lib/client.js:48`; `ui-settings-plugins/lib/client.js:377`). Composer uses `--dsw-alias-button-info-fill` (`ui-chat/lib/client.js:155`). Others use `brand-primary`, `button-primary-fill`, `border-l3`, `label-primary`, `label-tertiary`, `state-warn-label`. | — | retinting focus needs ~6 tokens |
| **Base font stack** | `:root{--dsw-font-family: …}` — `ui-theme/lib/client.js:1047` | ✓ matches measurement | referenced by all 30 scales |
| **Base font size (16 px)** | **owned by no package in `/tmp/dshc`.** No `body{font-size:16px}` / `html{font-size:16px}` in any shipped plugin bundle. `--dsw-font-base-16` is a per-component scale, not a body default. The measured 16 px comes from the UA default plus whatever the host shell (`@deepseek-ai/dsh-host-webserver`, **not extracted**) sets. **Cannot be determined from these files.** | — | — |
| Bubble text 14/22 | `font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))` — `ui-chat/lib/client.js:155` | user setting, default 14 | ✓ measured |
| **Content max-width** | `.wSkVaW_root{--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px))}` — `ui-conversation/lib/client.js:14652` | **`--dsh-*`, a layout axis, not a theme token** | 680–920 px, 64 % of the column. The user bubble is further capped at `min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)` (`ui-chat/lib/client.js:155`). |

> **Highest-leverage finding:** the send button, links, focus rings, spinners, the user bubble, the sidebar
> active accent, the bubble highlight and the deep-diving shimmer **all trace to the six-step
> `--dsw-static-deepseek-*` ramp.** Override `deepseek-50/100/200/400/450/500` and the frame re-brands.

> **Gotcha:** `--dsw-alias-brand-primary` is *not* the accent — it is `nb-1000` (`#0f1115`) light,
> `nb-50` dark, a high-contrast neutral. Re-pointing it at a brand hue recolours primary buttons and
> several focus rings and will likely break contrast against `--dsw-alias-label-primary-foreground`
> (`#fff`). The real accent aliases are `button-info-fill`, `link`, `state-business-primary`.

Layout constants (JS, **not** CSS media queries or tokens —
`ui-layout/lib/types/client/columns.d.ts:19-37`): `CENTER_MIN=400`, `SIDEBAR_MIN=264`, `SIDEBAR_MAX=420`,
`SIDEBAR_DEFAULT=280`, `SIDEBAR_COLLAPSED=56`, `SIDEBAR_AUTO_COLLAPSE=1024`, `RIGHTBAR_MIN=300`,
`RIGHTBAR_MAX_RATIO=0.7`, `RIGHTBAR_DEFAULT_RATIO=0.45`. The only `@media` in `ui-layout/lib/client.js:71`
is `prefers-reduced-motion`. Frame surfaces: `.pI_x6G_frame{background:var(--dsw-alias-bg-base)}`,
`.pI_x6G_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3)}`.

### 6. Conclusion — how to re-skin, ranked

**#1 — a client plugin calling `ctx.theme.overrideTokens(source, tokens)`. This is the answer.**

The kernel's documented token-layer extension point (`ui-theme/lib/client.js:1348-1376`;
`ui-theme/README.md:34-36`). No DOM patching, no `node_modules` patching.

- **Validation is shape-only, not name-whitelisted.** `validateOverrides`
  (`ui-theme/lib/client.js:1430-1442`) checks only that each value is `{light: string, dark: string}` —
  a bare string throws a teaching error (`:1433`). **Any custom-property name is accepted**, including
  `--dsw-static-*`, `--dsw-specific-*`, `--dsw-font-family`, `--shiki-*`.
  `exportInspectTokens()` documents 13 blessed aliases (`:1131-1223`) but does **not** gate
  `overrideTokens`; unknown names are folded in as `dynamicToken` (`:1289-1290`, `:1443-1451`).
- **Why it wins the cascade:** `ThemePresenter` writes the composed tokens as **inline styles on `body`**
  (`ui-layout/lib/client.js:475-478`), which beats the `body{}` / `body[data-ds-dark-theme]{}` author
  rules in `design-platform.css` and the `:root{}` rules of `base.css`/`shiki.css` for everything inside
  `<body>` — i.e. the whole app.
- **Minimum brand change:** one layer over `--dsw-static-deepseek-50/100/200/400/450/500`.
- **Cannot reach:** hard-coded literals (send-glyph `#fff`, `border-radius:999px`, bubble `22px`, the
  alphas inside shadow *lists*) and **all geometry** — no radius/spacing/z-index token family exists.
  Layout axes like `--dsh-chat-content-width` are declared *on a descendant*
  (`ui-conversation/lib/client.js:14652`) so a body-level override is shadowed — though its input
  `--dsh-chat-user-width` inherits and is worth testing.
- **Caveats:** the layer is memory-only and re-applied on every `theme/change`; it is **not** persisted
  (only `preference` and `fontSize` cross the settings boundary — `:1303`, `:1316`). One layer per
  `source`; re-calling replaces it. Upstream flags that "no validation exists that an override set is
  complete" (`ui-theme/README.md:101`).

**#2 — `ctx.theme.register()` + `setTheme(id)` for a named brand theme.** Same DOM reach. But token
values are **single strings, not `{light,dark}` pairs** (`ui-theme/lib/types/client/index.d.ts:43-53`),
so two ids are needed for two schemes; a third-party id is **not persistable** (`:1303`); and disposing
the plugin silently resets preference to `"system"` (`:1344`). Use *in addition to* #1 if the brand
theme should be a user-selectable choice.

**#3 — a client plugin mounting its own global stylesheet.** Copy the theme package's own pattern:
`ctx.effect(() => { …createElement("style"); tag.dataset.plugin = …; head.appendChild(tag); return () => tag.remove() })`
(`ui-theme/lib/client.js:1078-1090`). Ranked below #1/#2 because it is the only way to reach hard-coded
literals and geometry, but it must target **content-hashed CSS-module class names** (`.uV2eYG_primary`,
`.Sixlwa_bubble`, `.pI_x6G_frame`, `.wSkVaW_root`) — build outputs with no stability guarantee across
releases. Targeted last-mile patch only, pinned to a known package version. (This is the same class of
handle our four existing rules already use — `runtimeUiShell.mjs:299-334` — with the same caveat already
written there at `:213-217`.)

**#4 — the host `ui-theme` settings section / the pre-plugin bootstrap.** Legitimate and
schema-validated, but reaches only `preference` ∈ {light,dark,system} and `fontSize` ∈ [12,17]
(`ui-theme/lib/index.js:25-28`). Use it to pin a deployment default so first paint is correct with no
flash (`:38-49`). It cannot carry a palette. And for a non-loopback page the values become memory-only
(`ui-settings/lib/client.js:1345`).

**#5 — driving it from the embedding page. Not possible.** No listener, no parameter, no key, no global.
The only signal crossing the iframe boundary is the browser's own `prefers-color-scheme`, and only while
preference is `system`. **Plan for zero runtime theming control from `RuntimeUiFrame.tsx`; put everything
in the composed client plugin.**

**Recommended shape:** extend `packages/harness-port/src/runtimeUiShell.mjs` to inject `theme` and call
`ctx.theme.overrideTokens('@evimed/dsh-socket', { … })` with the six `--dsw-static-deepseek-*` steps
mapped to the shell's rust/warm-beige tokens, plus `--dsw-font-family` and the ~6 focus-ring aliases.
Add `@deepseek-ai/dsh-client-ui-theme` to `packages/socket/package.json` → `dsh.client.inject`.
Keep the existing stylesheet for the handful of hard-coded radii if needed.

---

## T5 — Locale

Path shorthand as in Section 0 (`dsh-client-<name>/` is written `<name>/`). **The bundles are not
minified** — dictionaries are pretty-printed one key per line, so every line number below is a real,
stable citation.

### 1. The mechanism

`locale/lib/types/client/index.d.ts`:

| Member | Signature | Cite |
|---|---|---|
| `addLanguage` | `({id, label, fallback}) => () => void`, idempotent disposer | `index.d.ts:159` |
| `register` (typed) | `register<N>(ns, { zh, en })` — **both** built-ins required, every key checked against the namespace key union | `index.d.ts:188` |
| `register` (untyped) | `register(ns, locale, dict)` — **the language-pack form** | `index.d.ts:198` |
| `setLocale(id)` | "the only user preference write entry"; unknown ids throw | `index.d.ts:146` |
| `bind(ns) => t` | stable identity per namespace, safe on `inject` surfaces | `index.d.ts:208`, `:215` |
| `getLocale` / `getSnapshot` / `subscribe` | snapshot `{active, locales, revision}` | `index.d.ts:119`, `:125`, `:133` |
| event `locale/change` | fires **only** on an active-locale switch, never on dictionary registration | `index.d.ts:68`; runtime `locale/lib/client.js:1318` |
| constants | `FALLBACK_LOCALE='en'`, `COMMON_NS='common'`, `SETTINGS_NS='settings.locale'` | `locale/lib/client.js:1019-1023` |

**Fallback resolves per key**, not per dictionary:

```js
translate(ns, key, params) {
  const chain = this.fallbackChain(this.snapshot.active);
  const template = this.lookup(ns, key, chain)
    ?? (ns !== "common" ? this.lookup("common", key, chain) : void 0)
    ?? key;
```

`locale/lib/client.js:1292-1296`; `lookup` walks the chain in order (`:1298-1303`); `fallbackChain` is
built and cached at `:1238-1255` and **always appends `en`** if the declared chain never reaches it
(`:1251`). So `zh-x-evimed → zh → en`, key by key — exactly what `runtimeUiShell.mjs:37-43` assumes.
Note the second line: an unresolved key also gets one pass through the **`common`** namespace before
falling back to the key string itself.

**Interpolation: `{name}`, literally `/\{(\w+)\}/g`** (`locale/lib/client.js:1296`). Names are `\w+`
only — no dots, no format specifiers; an unsupplied name is left verbatim. **There are no plural rules**
(`locale/README.md:130`), which is why every package hand-rolls `*.one` / `*.other` pairs and the call
site picks (e.g. `ui-chat/lib/client.js:3282-3284`).

**Partial override works, for the three-argument form.** `register` validates only the BCP-47 shape of
each tag and refuses a duplicate `(ns, locale)` pair; it never checks completeness
(`locale/lib/client.js:1256-1265`). The *typed* two-argument form is the one that demands complete `zh`
**and** `en` — EviMed must keep using the three-argument form, which it does
(`runtimeUiShell.mjs:252`).

**Two built-in languages only:** `LOCALE_IDS = ["zh","en"]` (`locale/lib/client.js:812`);
`BUILT_IN_LOCALE_METADATA = { zh: { label:"中文", fallback:"en" }, en: { label:"English" } }`
(`:1025-1031`). `LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u` (`:810`) — `zh-x-evimed`
passes. `addLanguage` validates shape at `:1041-1050` and walks `assertFallbackChain` for cycles and
termination at `en` at `:1225-1236`.

**Three caveats worth recording:**

1. **`<html lang>` becomes `zh-x-evimed`.** `syncDocumentLanguage` special-cases only the exact string
   `zh`: `document.documentElement.lang = snapshot.active === "zh" ? "zh-CN" : snapshot.active`
   (`locale/lib/client.js:1056-1059`). Our private-use tag therefore sets `lang="zh-x-evimed"` instead of
   `zh-CN`, which can affect font selection, hyphenation and screen-reader voice picking. **This is a
   live, unreviewed side effect of `runtimeUiShell.mjs:250-254`.**
2. **Registry-held copy freezes at registration time** — "copy captured at registration time outside the
   slot render path (e.g. the `/model` command description in the command registry) keeps the language it
   was registered under until re-registration" (`locale/README.md:129`). `setLocale` runs inside our
   `apply`, so anything registered *before* that switch keeps `zh`.
3. **Preference persistence is withheld off loopback** (`locale/README.md:64`, `:82`; durable field
   `locale.preference`, `locale/lib/types/locale-settings.d.ts:4-6`). Moot for us: we call `setLocale`
   on every boot.

### 2. Namespace catalogue

Key counts are `zh` entries in `lib/client.js`.

| Package | Namespace(s) | ≈ keys | zh dict |
|---|---|---|---|
| `locale` | `common`, `settings.locale` | 39 + 1 | `:817-857`, `:906` |
| `ui-chat` | `chat` | 103 | `:2623-2727` |
| `ui-conversation` | `conversation` | 159 | `:13634-13794` |
| `ui-trajectory` | `trajectory` | 175 | `:49-225` |
| `ui-workspace` | `workspace` | 63 | `:2568-2632` |
| `ui-agent-preset` | `settings.agentPreset` | 52 | `:105-157` |
| `ui-cordis` | `cordis` | 50 | `:1157-1208` |
| `ui-settings-models` | `settings.models` | ~50 | `:2751-…` |
| `ui-deliverables` | `deliverables` | 38 | `:831-870` |
| `ui-subagent` | `subagent` | 37 | `:731-769` |
| `ui-settings-plugin-inventory` | `settings.pluginInventory` | 36 | `:559-596` |
| `ui-settings-plugins` | `settings.plugins` | ~27 | `:1620-…` |
| `ui-sidebar-right` | `sidebarRight` | 21 | `:3524-3546` |
| `ui-message-feedback` | `feedback` | 20 | `:722-743` |
| `ui-model-selection` | `model` | 20 | `:795-816` |
| `ui-schedule` | `schedule.catalog` | 18 | `:241-260` |
| `ui-workflow-run` | `workflowRun` | 18 | `:443-462` |
| `ui-jobs` | `job` | 15 | `:214-230` |
| `ui-user-questions` | `question` | 15 | `:792-808` |
| `ui-commands` | `command` | 14 | `:165-180` |
| `ui-sidebar-files` | `sidebarFiles` | 13 | `:521-535` |
| `ui-permission-presets` | `settings.permission` | 12 | `:14-27` |
| `ui-goal` | `goal` | 12 | `:475-488` |
| `ui-settings-general` | `settings` | 12 | `:482-495` |
| `ui-reference` | `reference` | 10 | `:57-68` |
| `ui-input-trigger` | `slash.menu` | 9 | `:1069-1079` |
| `ui-open-in-app` | `open-in-app` | 9 | `:355-366` |
| `ui-theme` | `settings.theme` | 9 | `:1095-1105` |
| `ui-skill` | `skill` | 7 | `:192-200` |
| `ui-plan` | `plan` | 6 | `:85-92` |
| `ui-approval` | `approval` | 5 | `:209-215` |
| `ui-sidebar` | `sidebar` | 5 | `:309-315` |
| `ui-sidebar-documentpreview` | `sidebarDocumentPreview`, `documentMarkdown`, `documentHtml`, `sidebarImage`, `sidebarPdf`, `sidebarCodePreview` | 18/4/4/5/9/7 | `lib/types/client/**/locales.d.ts` |

**Fourteen packages own no namespace**: `connection`, `file-upload`, `hmr`, `modules`, `resources`,
`ui-attachment`, `ui-brand-official`, `ui-directory-picker-browse`, `ui-directory-picker-native`,
`ui-layout`, `ui-renderer`, `ui-session`, `ui-settings`, **`ui-tool`**.

> **Load-bearing:** `ui-tool` contains **zero Chinese characters** and owns no dictionary — it binds
> `const CONVERSATION_NS = "conversation"` (`ui-tool/lib/client.js:1539`) and reads every tool title out
> of the **`conversation`** namespace. All built-in tool titles are overridden through `conversation`.
> Same for `ui-session`: the session header chrome is rendered by `ui-conversation`
> (`ui-conversation/lib/client.js:14951`, `:15020-15082`) from the `conversation` namespace.

### 3. The zh strings to re-word

Our override table today covers **four keys in one namespace** (`runtimeUiShell.mjs:75-82`). Everything
below is un-overridden unless marked.

#### 3a. 「深度求索中…」 and the running-status family — namespace `chat`

`ui-chat/lib/client.js`; en line = zh line + 106 throughout.

| Key | zh | en | zh | en |
|---|---|---|---|---|
| **`chat.deepDiving`** | **深度求索中...** | Deep diving... | `:2641` | `:2747` |
| `duration.seconds` | {seconds}秒 | {seconds}s | `:2716` | `:2822` |
| `duration.minutes` | {minutes}分{seconds}秒 | {minutes}m {seconds}s | `:2717` | `:2823` |
| `duration.compactSeconds` | {seconds}秒 | {seconds}s | `:2626` | `:2732` |
| `duration.compactMinutes` | {minutes}分{seconds}秒 | {minutes}m{seconds}s | `:2627` | `:2733` |
| `duration.milliseconds` | {milliseconds}毫秒 | {milliseconds}ms | `:2628` | `:2734` |
| `message.ranFor` | 用时 {duration} | Ran for {duration} | `:2700` | `:2806` |
| `message.think` | 思考 | Think | `:2676` | `:2782` |
| `message.turnProcess.thoughtForAWhile` | 已思考 | Thought for a while | `:2684` | `:2790` |
| `message.stopped` | 已停止 | Stopped | `:2686` | `:2792` |
| `message.turnError` | 本轮运行失败 | This turn failed | `:2697` | `:2803` |
| `message.retry.cancelled` | 模型请求重试已取消 | Model request retry cancelled | `:2690` | `:2796` |
| `message.retry.active` / `.started` / `.scheduled` | 正在重试模型请求 / 已重试模型请求 / 等待重试模型请求 | Retrying / Retried / Waiting to retry | `:2689`,`:2691`,`:2692` | `:2795`,`:2797`,`:2798` |
| `message.retry.status` | {label}（{retry}/{maximum}） · {seconds}s | same shape | `:2693` | `:2799` |
| `row.running` / `row.failed` | 运行中 / 失败 | Running / Failed | `:2718`,`:2719` | `:2828`,`:2829` |
| `command.running` / `.failed` / `.done` | 执行中… / 指令失败 / 已完成 | Running… / Command failed / Completed | `:2714`-`:2716` | `:2824`-`:2826` |

**Render mechanics before re-wording:** `TurnStatus` renders `t("chat.deepDiving")` and, once elapsed
≥ 15 s, appends `formatRunDuration(elapsedMs, t)` in a separate `aria-hidden` span
(`ui-chat/lib/client.js:2036-2060`; threshold `showClock = elapsedMs >= 15e3` at `:2050`).
`formatRunDuration` uses `duration.minutes` / `duration.seconds` with zero-padded seconds (`:930-938`);
the *compact* variants belong to a different formatter used by the stats dialog (`:3916-3924`).

> 「深度求索」 is DeepSeek's own wordmark used as a verb. On a research bench it is a brand leak;
> 「正在分析…」 / 「推理中…」 is the neutral replacement. One key.

#### 3b. The turn-process collapsed summary — namespace `chat`

Rendered by `TurnProcessNodeView` (`ui-chat/lib/client.js:3277-3304`); labels joined with
`message.turnProcess.separator` at `:3285`.

| Key | zh | en | zh | en |
|---|---|---|---|---|
| `message.turnProcess.toolCalls.one` / `.other` | {count} 次工具调用 | {count} tool call(s) | `:2678`,`:2679` | `:2784`,`:2785` |
| `message.turnProcess.messages.one` / `.other` | {count} 条消息 | {count} message(s) | `:2680`,`:2681` | `:2786`,`:2787` |
| **`message.turnProcess.subagents.one` / `.other`** | **{count} 个 subagent** | {count} subagent(s) | `:2682`,`:2683` | `:2788`,`:2789` |
| `message.turnProcess.thoughtForAWhile` | 已思考 | Thought for a while | `:2684` | `:2790` |
| `message.turnProcess.separator` | ` · ` | ` · ` | `:2685` | `:2791` |

The mixed-script 「{count} 个 subagent」 is the most conspicuous untranslated string in the transcript.
Worse, the product uses **three different Chinese words for the same object** across four namespaces:

| Namespace | Key | zh | Cite |
|---|---|---|---|
| `chat` | `message.turnProcess.subagents.*` | {count} 个 **subagent** | `ui-chat/lib/client.js:2682-2683` |
| `subagent` | `count.total.one` / `.other` | {count} 个**子代理** | `ui-subagent/lib/client.js:759-760` |
| `subagent` | `count.running.one` / `.other` | {count} 个子代理，正在运行 | `:761-762` |
| `subagent` | `tree.aria` / `switcher.aria` | 子代理会话 / 切换子代理：{title} | `:764` / `:763` |
| `workspace` | `status.subagentsRunning.one` / `.other` | {n} 个子代理运行中 | `ui-workspace/lib/client.js:2614-2615` |
| `slash.menu` | `subagent` | **子智能体** | `ui-input-trigger/lib/client.js:1072` |

Unifying these (to 「子任务」 for a research bench) is a cheap, high-visibility win — six keys.

#### 3c. 「系统提示词」 and 「上下文注入」 — namespace `chat`

| Key | zh | en | zh | en |
|---|---|---|---|---|
| `message.systemPrompt` | 系统提示词 | System prompt | `:2653` | `:2759` |
| `message.systemPromptUpdate` | 系统提示词更新 | System prompt update | `:2654` | `:2760` |
| `message.contextInjection` | 上下文注入 | Context injection | `:2655` | `:2761` |
| `message.contextRecall` | 跨会话召回 | Session recall | `:2656` | `:2762` |
| `message.referenceSummary` | 引用会话 · {labels} | Referenced session · {labels} | `:2657` | `:2763` |
| `message.context.instructions.loaded/added/updated/removed` | 已载入/已新增/已更新/已移除 | loaded/added/updated/removed | `:2659-2662` | `:2765-2768` |
| `message.context.catalog.replaced` / `.more` | 替换目录 / …还有 {count} 条 | Replacement catalog / … {count} more | `:2663-2664` | `:2769-2770` |
| `message.context.snapshot.supersedes` | 取代先前的快照 | Supersedes earlier snapshots | `:2665` | `:2771` |
| `message.context.relay.from` | 来自会话 {session} | From session {session} | `:2666` | `:2772` |
| `message.context.recall.counts` | 保留 {retained} 条 · 省略 {omitted} 条 | {retained} kept · {omitted} omitted | `:2667` | `:2773` |
| `message.extraBlock` | 附加内容块 | Extra content block | `:2652` | `:2758` |
| `message.unknownSurface` | 未知 surface 事件：{type} | Unknown surface event: {type} | `:2677` | `:2783` |

> **Structural finding — a locale blank-out will NOT hide the row.** In
> 「上下文注入 · @deepseek-ai/dsh-system-prompt」 the 「 · 」 is **not text** and the producer name is
> **not a locale key**:
>
> ```js
> title: t(provenance.role === "recall" ? "message.contextRecall" : "message.contextInjection"),
> collapsedContent: provenance.label === null ? void 0
>   : (…<span className={…sep} aria-hidden/>, <span className={…source} data-context-source>{provenance.label}</span>…)
> ```
> `ui-chat/lib/client.js:864-874`. The separator is a 2×2 px styled `<span>`
> (`.XrJvXW_sep{…width:2px;height:2px;margin:0 8px}`, `ui-chat/lib/client.js:820`), and
> `provenance.label` is "the instruction paths, the referenced session titles, **the plugin id**, or the
> bare source kind" (`ui-conversation/lib/types/client/contract/context-provenance.d.ts:12-22`).
> Blanking the two keys leaves a chevron, a bullet and `@deepseek-ai/dsh-system-prompt` on screen.
> Use the slot route in §4.

Same words appear in three more namespaces — re-word together or they will diverge:
`conversation` / `context.system` 「系统提示词」 (`ui-conversation/lib/client.js:13687`);
`trajectory` / `tab.systemPrompt`, `record.systemPrompt`, `record.systemPromptMissing`,
`layout.initialSystemPrompt`, `layout.systemPromptUpdated`, `layout.systemPromptAndToolsUpdated`,
`kind.context`, `kind.system` (`ui-trajectory/lib/client.js:141`, `:161`, `:159`, `:220`, `:221`,
`:223`, `:66`, `:64`).

#### 3d. Built-in tool titles — namespace `conversation` (rendered by `ui-tool`)

`ui-conversation/lib/client.js`; en line = zh line + 162.

| Key | zh | en | zh | en | wire tool |
|---|---|---|---|---|---|
| `tool.title.bash` | Bash | Bash | `:13732` | `:13894` | `bash` |
| `tool.title.pwsh` | Pwsh | Pwsh | `:13741` | `:13903` | `pwsh` |
| `tool.title.read` | 读取 | Read | `:13731` | `:13893` | `read`, `web_fetch`, `cordis_*_inspect` |
| `tool.title.readImage` | 读取图片 | Read image | `:13742` | `:13904` | `read_image` |
| `tool.title.write` | 写入 | Write | `:13733` | `:13895` | `write` |
| `tool.title.edit` | 编辑 | Edit | `:13734` | `:13896` | `edit` |
| `tool.title.search` | 搜索 | Search | `:13730` | `:13892` | generic search |
| `tool.title.grep` | Grep | Grep | `:13743` | `:13905` | `grep` |
| `tool.title.glob` | Glob | Glob | `:13744` | `:13906` | `glob` |
| `tool.title.webSearch` | 网页搜索 | Search | `:13745` | `:13907` | `web_search` |
| `tool.title.webFetch` | 网页获取 | Fetch | `:13746` | `:13908` | `web_fetch` |
| **`tool.title.code`** | **代码** | Code | `:13735` | `:13897` | `run_code` |
| **`tool.title.generic`** | **工具调用** | Tool call | `:13736` | `:13898` | **every unregistered tool — i.e. all of ours** |
| `tool.title.inspect` | 查看 | Inspect | `:13737` | `:13899` | `cordis_*_inspect` |
| `tool.title.runCordis`/`stopCordis`/`removeCordis` | 运行/停止/移除 Cordis 插件 | Run/Stop/Remove Cordis Plugin | `:13738-13740` | `:13900-13902` | `cordis_*` |
| `todo.rowTitle` | 更新任务清单 | Update to-do list | `:13710` | `:13872` | `todo_write` |
| `ask.rowTitle` | 提问 | Ask question | `:13713` | `:13875` | `ask_user_question` |

Mapping tables: `VARIANT_TITLE_KEYS` (`ui-tool/lib/client.js:796-804`), `TOOL_VARIANTS` (`:814-831`),
`TOOL_TITLE_KEYS` (`:833-841`); `grep`/`glob` keyed rows at `:2204`/`:2209`; `web_search`/`web_fetch` at
`:2343`/`:2348`. Two tools live in their own namespaces: `skill` → `skill.row.title` "Skill"
(`ui-skill/lib/client.js:193`, registered `:233`) and `present` → `deliverables.row.title` 「交付文件」
(`ui-deliverables/lib/client.js:859`, registered `:952`).

> **There is no `task` toolview key.** Every EviMed tool — `evimed_plan`, `evimed_delegate`,
> `evimed_submit_deliverable`, and all 26 `mcp__evimed__*` — falls through to
> `tool.title.generic` 「工具调用」 with a flattened JSON body. That is what a delegated deep-research
> run looks like in the transcript today.

Row chrome, also `conversation`: `row.running`/`row.failed`/`row.stopped` 运行中/失败/已停止
(`:13724-13726`); `row.input`/`row.output`/`row.inspect` 输入/输出/查看 (`:13727-13729`);
`bash.running`/`.failed`/`.stopped` (`:13721-13723`); `terminal.exitCode`/`.signal`/`.session`
(`:13783-13784`, `:13793`); `read.window` 「显示 {shown} / {total} 行」 (`:13752`);
`search.matches` (`:13758`); `diff.files.one`/`.other` (`:13747-13748`); `details.running` 「运行中…」
(`:13768`).

#### 3e. The end-of-turn stats line — namespace `chat`

`TurnTimePanel` at `ui-chat/lib/client.js:3560-3605`; usage panel `:3530-3550`; session footer
`:3944-3990`.

| Key | zh | en | zh | en |
|---|---|---|---|---|
| `message.ranFor` | 用时 {duration} | Ran for {duration} | `:2700` | `:2806` |
| `message.tokensPerSecond` | {tps} tok/s | {tps} tok/s | `:2701` | `:2807` |
| `message.turnTime.title` | 本轮用时和速度 | Turn time and speed | `:2712` | `:2818` |
| `message.turnTime.duration` | 本轮总用时 | Total run time | `:2713` | `:2819` |
| `message.turnTime.speed` | 输出速度（TPS） | Tokens per second (TPS) | `:2714` | `:2820` |
| `message.turnTime.ttft` | 首 token 用时（TTFT） | Time to first token (TTFT) | `:2715` | `:2821` |
| `message.turnUsage.title` | 本轮用量 | Turn usage | `:2702` | `:2808` |
| `message.turnUsage.consumed` | 用量 {total} | Usage {total} | `:2703` | `:2809` |
| `message.turnUsage.model` | 提供方 / 模型 | Provider / model | `:2704` | `:2810` |
| `message.turnUsage.cacheHit` | 缓存命中 | Cache hit | `:2705` | `:2811` |
| `message.turnUsage.input` | 未缓存输入 | Uncached input | `:2706` | `:2812` |
| `message.turnUsage.cacheRead` / `.cacheWrite` | 缓存读取 / 缓存写入 | Cached input / Cache write | `:2707-2708` | `:2813-2814` |
| `message.turnUsage.output` | 输出 | Output | `:2709` | `:2815` |
| `message.turnUsage.reasoning` | （其中推理 {tokens}） | ` ({tokens} reasoning)` | `:2710` | `:2816` |
| `message.turnUsage.count` | {count} tok | {count} tok | `:2711` | `:2817` |
| `stats.counts` | {turns} 轮 {steps} 步 | {turns} turns {steps} steps | `:2629` | `:2735` |
| `stats.cacheHit` | 缓存命中 {percent}% | Cache hit {percent}% | `:2630` | `:2736` |
| `stats.dialog.title` | 会话统计 | Session statistics | `:2631` | `:2737` |
| `stats.dialog.usageTitle` | Token 用量 | Token usage | `:2632` | `:2738` |
| `stats.dialog.llmTime` / `.toolTime` | 模型用时 / 工具调用用时 | LLM time / Tool time | `:2633-2634` | `:2739-2740` |
| `stats.dialog.ttft` / `.speed` | 首 token 平均（TTFT） / 输出速度（TPS） | Avg TTFT / TPS | `:2635-2636` | `:2741-2742` |
| `number.thousand` / `number.million` (ns `common`) | {value}K / {value}M | {value}K / {value}M | `locale/lib/client.js:855-856` | `:899-900` |

**No cost/price key exists in any of the 47 packages** — the turn footer reports tokens and time only. A
cost line must come from an EviMed `conversation.chat.turnTail` chain entry, not from a locale override.

#### 3f. Session header, right sidebar, empty states

| Namespace | Key | zh | en | zh | en |
|---|---|---|---|---|---|
| `conversation` | `session.hierarchy` | 会话层级 | Session hierarchy | `ui-conversation:13705` | `:13867` |
| `sidebarRight` | **`tab.guide.title`** | **开始** | Start | `ui-sidebar-right:3544` | `:3568` |
| `sidebarRight` | **`dock.addTab`** | **新标签页** | New tab | `:3536` | `:3560` |
| `sidebarRight` | `tab.unavailable` | 这类内容还没有可用的查看方式。 | Nothing here can view this kind of content yet. | `:3545` | `:3569` |
| `sidebarRight` | `dock.emptyPane` | 空面板 | Empty pane | `:3531` | `:3555` |
| `sidebarRight` | `dock.splitPane` / `.splitPaneDisabled` / `.splitPaneNarrow` | 分栏 / 已达两格上限 / 栏宽不足，拖宽侧边栏后再分栏 | Split / Two panes is the limit / … | `:3532-3534` | `:3556-3558` |
| `sidebarRight` | `chrome.expand`/`.collapse`/`.toFullscreen`/`.exitFullscreen` | 打开侧边栏/收起侧边栏/全屏/退出全屏 | … | `:3525`,`:3527`,`:3529-3530` | `:3549`,`:3551`,`:3553-3554` |
| `sidebarRight` | `dock.dockFloat`/`.closeFloat`/`.closeTab` | 收回到侧边栏/关闭/关闭 | … | `:3537-3538`,`:3535` | `:3561-3562`,`:3559` |
| `sidebarRight` | `dock.drop.center/left/right/top/bottom` | 移到这里/左分栏/右分栏/上分栏/下分栏 | Move here / Add … split | `:3539-3543` | `:3563-3567` |
| `sidebarFiles` | `guide.title` / `guide.description` | 工作区文件 / 浏览会话工作区的文件 | Workspace files / Browse files… | `ui-sidebar-files:523-524` | `:539-540` |
| `sidebarFiles` | `empty` / `noWorkspace` / `truncated` | 空目录 / 这个会话没有工作区目录。 / 条目太多，只显示了一部分。 | … | `:526-528` | `:542-544` |
| `trajectory` | `view.trajectory` | 轨迹 | Trajectory | `ui-trajectory:50` | `:228` |
| `chat` | `view.chat` | 对话 | Chat | `ui-chat:2624` | `:2730` |
| `workspace` | `empty.none` / `empty.noMatches` | 暂无会话 / 无匹配结果 | No sessions yet / No matches | `ui-workspace:2582-2583` | `:2648-2649` |
| `workspace` | `search.noMatches` / `search.unavailable` | 无匹配会话 / 内容搜索暂不可用，仅显示名称匹配。 | … | `:2591`, `:2590` | — |
| `sidebar` | `session.new` / `session.new.label` | 新会话 / 新建会话 | New Session / New session | `ui-sidebar:310-311` | `:318-319` |
| `model` | `empty.models` / `empty.efforts` | 没有可用的模型。/ 当前模型未提供推理等级。 | — | `ui-model-selection:813`, `:815` | — |
| `settings.locale` | `language.title` | 语言 | Language | `locale:906` | `:908` |

The guide tab's title is read fresh on every render — `title: () => t("tab.guide.title")`
(`ui-sidebar-right/lib/client.js:3584-3590`) — so a locale override takes effect live.

#### 3g. 「构建」/「coding」/「Preview」 — what reads wrong on a research bench

| Namespace | Key | zh | en | Cite | Status |
|---|---|---|---|---|---|
| `conversation` | `hero.headline` | 探索未至之境 | Into the Unknown | `ui-conversation:13702` / `:13864` | **overridden** (`runtimeUiShell.mjs:77`) |
| `conversation` | `hero.preview` | 预览版 | Preview | `:13703` / `:13865` | **blanked** (`:78`) |
| `conversation` | `placeholder.hero` | 描述你想要**构建**的内容, / 调用指令, @ 文件或对话 | Describe what you want to **build**… | `:13642` / `:13804` | **overridden** (`:79`) |
| `conversation` | `placeholder.default` | 发消息或创建任务, / 调用指令, @ 文件或对话 | Send a message or create a task… | `:13639` / `:13801` | **overridden** (`:80`) |
| **`common`** | **`brand.localBuild`** | **DSH 本地构建** | DSH Local Build | `locale:846` / `:890` | **not overridden** — leaks both "DSH" and 「构建」, and sits in `common`, which every namespace's fallback pass consults (`locale/lib/client.js:1294`) |
| `settings.agentPreset` | `presetStandardDescription` | 功能完整的**编码 Agent**，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。 | full-featured coding agent… | `ui-agent-preset:116` | not overridden (panel disabled) |
| `settings.agentPreset` | `presetPtcDescription` / `presetMinimalDescription` / `sectionIntro` | 功能完整的编码 Agent… / 仅提供持久 shell 的单工具编码 Agent。/ 预设即一个会话的 Agent 所运行的插件组装… | … | `:118`, `:120`, `:111` | not overridden (panel disabled) |
| `model` | `option.deepseekV4Pro.description` | 更强的**自主编码**、知识与复杂推理能力… | Stronger agentic coding… | `ui-model-selection:799` / `:822` | not overridden (panel disabled) |
| `conversation` | `tool.title.code` | 代码 | Code | `:13735` / `:13897` | not overridden |
| `cordis` | `body.source` | 插件代码 | Plugin source | `ui-cordis:1202` | low priority (disabled) |
| `conversation` | `placeholder.workspace` | 选择一个工作区开始 | Choose a workspace to start | `:13643` / `:13805` | reads oddly — our workspace is control-plane bound |

### 4. Hiding the transcript rows — a documented switch exists, and it is **not** the transcript mode

Four routes checked.

**(a) Transcript Normal/Compact — real and host-settable, but it does NOT hide these rows.** The
setting exists (namespace `ui-chat`, field `transcriptView`, modes `["normal","compact"]`, default
`compact` — `ui-chat/lib/client.js:8169-8176`; typed at `lib/types/chat-settings.d.ts:4-12`; host
registration `settingsCtx.settings.register("ui-chat", ChatSettingsSchema)` at
`ui-chat/lib/index.js:18-22`; a deployment may also declare a **composition `base` layer** for the
namespace, which is what a cleared field reverts to —
`ui-settings/lib/types/client/settings-contract.d.ts:15-19`). But Compact **explicitly excludes** the
system prompt from folding:

```js
const TURN_PROCESS_INDEPENDENT_KINDS = new Set(["system-prompt","user","steering","turn-process","turn-error","turn-max-tokens","turn-tail"]);
```

`ui-chat/lib/client.js:1415-1423`, consumed at `:1556`; restated in prose at `ui-chat/README.md:48`.
Context-injection rows (`kind: 'context'`) *are* foldable, but only into a disclosure the user can
reopen, and only on a **completed** turn once history is fully loaded (`:1555`). Compact is already our
default, so this buys nothing.

**(b) A node-type filter — does not exist.** There is a `visibility: 'visible' | 'hidden'` field on
`ChatConversationViewNode` (`ui-chat/lib/types/client/contract/chat-nodes.d.ts:7`), but it is produced by
the target's own node Definitions; no public API accepts a kind allowlist.

**(c) `conversation.chat.node` keyed shadowing — YES, this is the route.**

```ts
/**
 * Final Chat node renderer, keyed by `ChatNodeKind`. … Reusing a key
 * replaces that node renderer; a kind with no occupant renders no row.
 */
'conversation.chat.node': { kind: 'keyed'; scope: 'session'; owner: ChatNodeOwnerProps; … }
```

`ui-chat/lib/types/client/contract/slots.d.ts:139-155`. And a *dynamically registered* entry wins the
election: "a dynamically registered entry is assigned a lower priority than the shipped one, which makes
it the winner" (`ui-renderer/lib/types/client/registry.d.ts:18-31`);
`entriesOfSlot` is "**Shadowing winners per cell** … the first live (non-abdicated) entry of each cell in
priority order — what outlets render" (`ui-renderer/lib/types/client/registry.d.ts:155-162`; runtime
`ui-renderer/lib/client.js:1191-1202`; keyed dispatch at `:826-827`).

The two kinds to shadow:
- `'system-prompt'` — shipped at `ui-chat/lib/client.js:3705-3709` (`SystemPromptNodeView`); declared at
  `lib/types/client/conversation-nodes/request-prompt.d.ts:3-11`.
- `'context'` — shipped at `ui-chat/lib/client.js:3700-3704` (`ContextMessageNodeView`); declared at
  `lib/types/client/conversation-nodes/message.d.ts:16-25`.

Two caveats to design around:
1. **`context` is one kind for two roles** — the same renderer serves injections *and* cross-session
   recall, distinguished by a runtime field `provenance.role === "recall"`
   (`ui-chat/lib/client.js:859`, `:864`). A replacement receives the typed node, so it can return `null`
   for `role === 'inject'` and keep recall visible.
2. **The seat wrapper survives.** `ChatNodeSeat` always renders
   `<div className={flowItem} data-chat-flow-kind=…>` around the slot output
   (`ui-chat/lib/client.js:1603-1622`); `flowItem` is only `{min-width:0}`, so an empty div adds no box,
   but it stays in the flex flow. Cosmetic, not a blocker.

**(d) A client config — no.** No client-level switch for node kinds beyond `transcriptView`.

**Verdict.** Do **not** blank the locale keys: `provenance.label` (`@deepseek-ai/dsh-system-prompt`,
`skill-catalog`) is plain data, not a locale key
(`ui-chat/lib/client.js:865-874`;
`ui-conversation/lib/types/client/contract/context-provenance.d.ts:12-22`), so the row would remain with
a bullet and a bare plugin id. The supported route is keyed-slot shadowing on `conversation.chat.node`
for `system-prompt` and `context`, gated on the operator flag already present in `__EVIMED_FRAME__`
(`runtimeUiShell.mjs:91-100`) so operators keep the rows.

---

## T4 — Composer and commands (complaint #4: the capability pill row)

### The composer's slots, with their exact registration rules

All declared by `ui-conversation/lib/types/client/contract/slots.d.ts:110-236`.

| Slot | Kind | Scope | Registration key | Owner props | Occupied today |
|---|---|---|---|---|---|
| `main.conversation` | single | `session-maybe` | priority | — | `ui-conversation` |
| `conversation.session` | single | session | priority | — | `ui-conversation` |
| `conversation.session.header` | single | session | priority | — | `ui-conversation` |
| `conversation.session.header.lineage` | single | session | priority | `ConversationHeaderLineageOwnerProps` | `ui-subagent` |
| `conversation.session.header.actions` | **list** | session | **`id`** + `order` | `ConversationHeaderActionOwnerProps` | `ui-jobs`, `ui-schedule` (off), `ui-agent-preset` (off) |
| `conversation.session.header.utilities` | **list** | session | **`id`** + `order` | `ConversationHeaderActionOwnerProps` | `ui-open-in-app` (off) → **empty** |
| `conversation.session.header.corner` | single | session | priority | `ConversationHeaderCornerOwnerProps` | `ui-sidebar-right` (the expand button) |
| `conversation.view` | **list** | session | **`id`** + `order` + `label` | `ConvViewOwnerProps` | `ui-chat` (`id:'chat'`, `order:0`), `ui-trajectory` (operator only) |
| `conversation.composer` | **chain** | session | selector | `ComposerChainProps` | `ui-approval`, `ui-user-questions`, `ui-subagent` |
| `conversation.hero.workspace` | single | **root** | priority | `EmptyWorkspaceOwnerProps` | our `Nothing` at `-1` |
| `conversation.hero.brand.mark` | single | **root** | priority | `HeroBrandMarkOwnerProps` | our `Mark` at `-1` |
| `conversation.hero.agentPreset` | single | **root** | priority | `HeroAgentPresetOwnerProps` | `ui-agent-preset` — **disabled, so the slot is never declared** |
| **`conversation.input.dock`** | **list** | session | **`id`** | `InputZone` | our `CapabilityDock` (`id:'evimed-capabilities'`), `ui-goal` (off) |
| `conversation.input.overlay` | **list** | session | **`id`** | — | `ui-input-trigger` (`MenuView`), `ui-commands` (`PopupSelectView`), `ui-message-feedback` (off) |
| `conversation.composer.dock` | **list** | session | **`id`** + `order` | — | `ui-chat` (`StatsPills`, `id:'stats'`, `order:0`) |
| `conversation.input.left` | **list** | session | **`id`** | — | **empty** |
| `conversation.input.right` | **list** | session | **`id`** | — | **empty** |
| `conversation.composer.bar` | single | `session-maybe` | priority | `ComposerBarOwnerProps` | `ui-conversation` |
| `conversation.input.attachments` | single | `session-maybe` | priority | `ComposerAttachmentsOwnerProps` | `ui-attachment` |
| `conversation.input.plan` | single | session | priority | `InputControlOwnerProps` | `ui-plan` (renders nothing unless plan mode) |
| `conversation.input.model` | single | session | priority | `InputControlOwnerProps` | `ui-model-selection` — **disabled** |

Registration-shape rules, in one place:

- **list slot** — needs `id` (and takes an optional `order`); additive.
- **keyed slot** — needs `key`; reusing a shipped key **replaces** it
  (`ui-tool/lib/types/client/contract/slots.d.ts:14-16`,
  `ui-chat/lib/types/client/contract/slots.d.ts:142`).
- **single slot** — lowest `priority` wins, and a second registration at the same priority throws
  "already has a registration"; the kernel's own occupants register at the default `0`, and a
  dynamically registered entry is assigned a lower priority than the shipped one, making it the winner
  (`ui-renderer/lib/types/client/registry.d.ts:22-30`). Our shell deliberately uses `priority: -1`
  and documents why at `packages/harness-port/src/runtimeUiShell.mjs:219-226`.
- **chain slot** — selectors run in chain order; the first non-declining entry renders
  (`ui-sidebar-right/lib/types/client/contract/slots.d.ts:46-50`,
  `ui-chat/.../slots.d.ts:176-180`).

> **Note `conversation.input.left` and `conversation.input.right` are empty list slots** — "compact
> controls at the left of the composer tool row" and "compact controls before the composer submit
> action" (`ui-conversation/.../slots.d.ts:202-211`). Nothing in the shipped composition occupies either.
> These, not `conversation.input.dock`, are the composer's natural seats for a small control.

### The `/` command surface — how to make the fifteen capabilities native

`ui-commands` publishes `ctx.commandUi`, a **frozen, types-only contract** whose whole business surface
is two methods (`ui-commands/lib/types/client/contract.d.ts:80-97`):

```ts
interface CommandUiContract {
  register(contribution: CommandContribution): () => void;   // a client-owned command
  decorate(decoration: CommandDecoration): () => void;       // a popup on an EXISTING host command
  popupFor(actx): unknown;                                   // wiring layer only
}
```

**`CommandContribution`** (`contract.d.ts:52-70`):

```ts
{
  name: string,                                          // without the leading slash, unique
  description: () => string,                             // thunked → follows the current language
  available(session: ClientSessionContext): boolean,      // capability filter, fresh per candidate pass
  ui: CommandUiSpec
}
```

**The three command UI kinds** (README, Summary + `contract.d.ts:26-51`):

| Kind | Shape | Behaviour |
|---|---|---|
| `popupSelect` | `{ kind:'popupSelect', options(session, signal): Promise<SelectOption[]>, onSelect(option, session) }` | Opens the shared popup shell, which `ui-commands` owns — "business never sees it" (`contract.d.ts:24-32`). `SelectOption = { id, label, detail?, active?, confirmation? }` (`contract.d.ts:17-24`); `confirmation` is an in-page risk gate with its own title/description/acknowledge/cancel/confirm copy (`contract.d.ts:8-14`). |
| `action` | `{ kind:'action', run(session) }` | Bare invocation consumes the token and runs one client-side callback. "It submits nothing, so an attachment-carrying draft never refuses it" (`contract.d.ts:34-40`). |
| `leadingInput` | not a client spec — a **host** descriptor declaring `input` | "Space and Enter resolve the line against the session's directory: a host descriptor with `input` is `leadingInput`, a registered `CommandUiSpec` is its kind, and everything else is `execute`" (README, Summary). |

Other mechanics worth knowing before designing this:

- **A name collision with a host command fails loud at candidate synthesis, never shadows**
  (`contract.d.ts:47-51`). `decorate` is the route for adding a popup to a host command; the host keeps
  its catalogue row, argument claim and lifecycle logging, and "a decorated name with no host row in the
  session's directory never fires" (`contract.d.ts:71-79`).
- **Menu matching:** "fuzzy-match ordered, case-insensitive subsequences of command names; prefixes rank
  first" (README, Kinds and decorations).
- **Directory cache:** keyed by session, fetched via `command.list({sessionId})`, soft-invalidated by the
  forwarded `commands/change` event, hard-invalidated by `connection/reset`, epoch-guarded
  (README, Understand the implementation).
- **Attachments:** a submission carrying images or generic files proceeds **only** for a host command
  declaring `input.attachments`; every other route throws the localized `attachmentsUnsupported` refusal
  as a transient toast, leaving the draft and the attachment cards in place (README).
- `PopupSelectView` self-registers into `conversation.input.overlay` with per-session resolution.

> **Answer to complaint #4.** The fifteen capabilities can be native in two shapes, and both are
> documented:
>
> 1. **One `popupSelect` command** — e.g. `/能力` or `/capability` with fifteen `SelectOption` rows
>    (`label` = title, `detail` = the one-line brief), `onSelect` doing what `CapabilityDock`'s click
>    does today (`runtimeUiShell.mjs:188-190`). One command, one popup, zero pills, and it appears in the
>    `/` menu that researchers already see.
> 2. **Fifteen `action` contributions** — one per capability, each with `description()` from the domain's
>    brief and `run(session)` navigating through the shell. Discoverable by typing part of a capability
>    name; `available()` can hide `visibility: internal` ones.
>
> Either replaces the `<details>` pill row at `runtimeUiShell.mjs:176-193`. Both need
> `@deepseek-ai/dsh-client-ui-commands` added to `packages/socket/package.json` → `dsh.client.inject`.
> Shape 1 is the smaller change and keeps one entry in the menu; shape 2 is more discoverable.

### The `@` reference pipeline

`ui-input-trigger` publishes `ctx.inputTriggers` with exactly one business method
(`ui-input-trigger/lib/types/client/contract.d.ts:11-18`): `registerSource(src) => dispose`; duplicate
trigger/name pairs throw. The source contract (`ui-input-trigger/lib/types/types.d.ts:118-192`):

```ts
interface InputTriggerSource {
  trigger: '/' | '@',
  name: string,                 // menu group label, unique per trigger
  order?: number,               // group display order, default 0
  showGroupTitle?: boolean,     // default true
  candidates(session, req: { query, quoted?, position, drilled, signal }): Promise<InputTriggerCandidate[]>,
  header?(session, req): InputTriggerCrumb[] | undefined,   // breadcrumbs above the group
  onPick(pick: InputTriggerPick): PickOutcome,
  matchSpace?(session, token): PickOutcome,                 // sync, hot state only
  matchEnter?(session, line, signal, envelope): Promise<PickOutcome>,
  warm?(session): void,                                     // scope-birth prewarm, fire-and-forget
  lexicon?(session): readonly string[] | undefined,         // sync roll for plain-text decoration
  subscribeLexicon?(session, listener): () => void,
  codec?: ReferenceCodec                                    // required for insert outcomes
}
```

`InputTriggerCandidate` is "pure display data — zero behaviour declaration":
`{ name, description?, icon?: 'file'|'folder'|'session', hint?, section?, value?, drill? }`
(`types.d.ts:33-52`). `drill: true` gives a row a second verb (Tab or a trailing chevron) that refines
the query in place instead of resolving — the directory-descent affordance.

`ReferenceCodec` (`types.d.ts:104-112`) has two methods: `clipboardText(ref)` for copy/persistence and
`serialize(ref, signal)` for **model serialization** — "failure blocks the send — never a silent
downgrade to the clipboard text". `ui-skill` uses it to turn `@name` into `<skill>name</skill>`.

`TriggerGuard` tiers (`types.d.ts:193-197`): `plain` = `/` and `@` live; `claimed` = `/` suppressed,
`@` live; `frozen` = none.

Sources registered today: `ui-commands` (`/`), `ui-reference` (`@file`, `@session`), `ui-skill`
(`@skill`), `ui-subagent` (`@` running children — "deliberately separate and inert": zero-RPC candidates
from `ctx.sessions.list`, picking inserts literal `@label ` text, no continuation semantics —
`ui-subagent/README.md`, The `@` reference source).

> **Unused opportunity:** an `@` source over our own **knowledge base** — `src_<sha256>` sources from
> `sourceService.mjs` — with `codec.serialize` expanding to whatever the run should see. That is the
> kernel-sanctioned way to let a researcher reference an ingested paper in a prompt, and it needs no
> `workspaceFiles` access.

### The blank-session hero, with `ui-agent-preset` disabled

The hero renders (`ui-conversation/lib/client.js:14625-14646`):
`renderSlot('conversation.hero.brand.mark', { size: 34, className: fish }, { fallback: <HeroFish/> })`
→ the headline `t('hero.headline')` → a `previewBadge` span carrying `t('hero.preview')`; below it
`renderSlot('conversation.hero.workspace', {...})` and `renderSlot('conversation.hero.agentPreset', {})`
(`:14886-14901`).

All three hero slots are **`scope: 'root'`**, not `session`
(`ui-conversation/.../slots.d.ts:168-185`) — which matters: a hero occupant must not assume a session.

**`conversation.hero.agentPreset` is not available to us.** It is declared by `ui-conversation` but the
only package that ever registered into it is `ui-agent-preset`, which is disabled
(`apps/server/src/dshProfilePatch.mjs:308`). `runtimeUiShell.mjs:152-159` already records the empirical
finding — "a disabled row declares no slot, so occupying it registered nothing and rendered nothing,
silently" — but the *mechanism* is worth stating precisely: **the slot's declaration is committed by the
`register()` call that owns the parent seat** (`ui-renderer/lib/types/client/registry.d.ts:84-100`), and
`ctx.slots.inject(key, cb)` never fires its callback if the key is never declared (`registry.d.ts:86-99`).
So the wait simply never resolves. `conversation.hero.workspace` and `conversation.hero.brand.mark`
*are* declared (by `ui-workspace` and `ui-conversation`'s own registration), which is why our two
occupants there work.

**The remaining free hero surface is therefore:** `conversation.input.dock` (already ours, always
visible), `conversation.input.left` / `.right` (empty, composer tool row), and
`conversation.composer.dock` (one shipped entry, `StatsPills`). Nothing hero-specific — so a
blank-session-only affordance has to be conditional inside a dock occupant, which is what
`runtimeUiShell.mjs:160-165` already decided against for a separate reason.

### Attachments and file upload

`ui-attachment` occupies four slots — `conversation.input.attachments` (single, `session-maybe`),
`conversation.message.images` (single), `conversation.trajectory.images` (single),
`tool.call.images` (single) — and declares none. `tool.call.images` is documented as **"A child slot is
declared by exactly one entry: registering a second toolview that declares the same child throws at
load"** (`ui-tool/lib/types/client/contract/slots.d.ts:26-45`) — a constraint to respect if we ever add
an image-bearing toolview.

`file-upload` registers a raw-byte POST at `/api/session/uploadFileBinary` **on the connection's own
fetch registry, beside the mux rather than inside it** — our deny list names that path explicitly
(`packages/domain/src/runtimeUiSurface.mjs:134-140`) alongside the `fileUploads` namespace ban
(`:102`). Yet the `file-upload` row **must stay mounted**: "booting with `file-upload` disabled fails
with `dsh-api-session-controller: pending (waiting for service: fileUploads)`, taking the deliverables
panel down after it" (`runtimeUiSurface.mjs:95-98`). So the composer still shows an attachment
affordance whose upload the control plane refuses. **Unverified from these files: what the user sees
when that POST is denied** — worth a live check.

---

## T6 — Native capabilities we are not using

### Branching (fork) — live, invisible, and free

`ui-chat` wires `forkAt(seq)` into every chat node
(`ui-chat/lib/client.js:8338-8347`):

```js
forkAt: (seq) => {
  ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
    .then((childId) => { ctx.sessions.open(childId); }).catch(() => {});
}
```

The copy already exists in `chat`: `message.branch` 「在新对话中分支」 (`ui-chat/lib/client.js:2687`)
and `message.branchUnavailable` 「仅可从已完成轮次的最后一条消息分支」 (`:2688`). The wire method is
`session/fork` (`connection/lib/client.js`), **not in our deny list**
(`packages/domain/src/runtimeUiSurface.mjs:113-141`). `TurnTailNodeView` calls
`forkAt(closing.finalNode.seq)` (`ui-chat/lib/client.js:3637`, `:3665`).

> A researcher can already branch a conversation from a finished turn and get a new session, and the
> control plane knows nothing about it — the child session exists in the kernel's workspace registry but
> has no project row, no run ledger entry, and no place in the shell's 任务/会话 navigation.
> **This is the one native capability that is on, works, and is unaccounted for.** Worth a live check of
> what the shell does with a forked session id.

### Retry

`llm/retry` is a wire method (`connection/lib/client.js`) referenced by both `ui-chat` and
`ui-trajectory`. The `chat` namespace ships the full status family (`message.retry.active` / `.started` /
`.scheduled` / `.cancelled` / `.status` / `.delay` / `.failure`, `ui-chat/lib/client.js:2689-2695`) plus
`message.failure.auth` 「API 密钥无效」 (`:2696`) and `message.maxTokens` /
`message.maxTokens.hint` 「回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。」
(`:2698-2699`). These render today and are un-reviewed product copy.

### Turn navigation (the turn rail)

`ui-chat` renders a fixed-pitch mark ladder on the right edge of the transcript, 10 px apart, with
card-sized hover previews (one prompt line of 50 chars, up to three response lines of 120)
(`ui-chat/README.md`, Known Limitations). Copy: `chat.turnNavigation.label` 「轮次导航」,
`.jump` 「跳转到第 {turn} 轮」, `.jumpLoad` 「加载并跳转到第 {turn} 轮」, `.turn` 「第 {turn} 轮」
(`ui-chat/lib/client.js:2643-2646`).

**It degrades without a host projection:** "the rail merges the loaded Turns with the host `turnOutline`
projection, so every started Turn gets a fixed-pitch mark … Without the projection (assemblies not
mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only"
(`ui-chat/README.md`, Known Limitations; the merge point is
`ui-chat/lib/types/client/chat/turn-rail-items.d.ts:4`, `:33`).
**`dsh-session-turn-outline` has no row in `deploy/runtime-dsh/dump-config.baseline.json`** — so our rail
shows only loaded turns. On a 362-message run that is a real loss of navigation.
The rail also hides below a 900 px container (`@container (width<=900px)` in
`ui-chat/lib/client.js:1626`), which matters given the measured 680 px centre column at 1440 px viewport
(`00-live-findings.md` F2).

### Session search

`session/search` is a wire method, not denied; `ui-workspace` renders the search box with a full copy set
— `search.sessions.aria` 「搜索会话」, `search.placeholder`, `search.clear`, `search.pending`,
`search.hasMore` 「{n}」, `search.noMatches` 「无匹配会话」, `search.unavailable`
「内容搜索暂不可用，仅显示名称匹配。」 (`ui-workspace/lib/client.js:1941-2345`, zh at `:2585-2591`).
**It lives in the left column, which our shell replaces with nothing**
(`runtimeUiShell.mjs:237`, `:330`). Full-text search across a project's sessions is therefore shipped,
paid for, and unreachable — while the product's own 任务/会话 lists offer no content search.

### The composer's queue / steer behaviour

Two send behaviours while the agent is running, with a persisted preference:
`settings.enter.title` 「繁忙时的发送行为」, `.description`
「智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为」, `.queue` 「排队发送」,
`.steer` 「插话发送」 (`ui-conversation/lib/client.js:13690-13693`). The preference is a
`settings.general.item` row, `id: 'composer-enter'`, `order: 20`
(`ui-conversation/lib/client.js:16531-16534`) — **unreachable, because `ui-settings-general` is
disabled**, so it always runs on its default.

The queue itself is fully built: edit, remove, steer, per-item errors —
`queue.count` 「{n} 条排队消息」, `queue.sending`, `queue.edit`, `queue.edit.unsupported`
「包含非文本内容，暂不支持编辑」, `queue.save`, `queue.cancelEdit`, `queue.remove`, `queue.steer`
「插话发送」, `queue.steer.unavailable` 「仅运行中可插话发送」, `queue.editFailed`, `queue.removeFailed`,
`queue.steerFailed` (`ui-conversation/lib/client.js:13769-13782`); driven by
`session.updateQueue(item.id, { kind: 'steer' })` (`:13522`) → wire `session/updateQueue`, **not
denied**. The composer placeholder is `placeholder.steerQueue`
「Cmd/Ctrl+Enter 插话发送全部排队消息」 (`:13644`).

> **For a run that takes 8–28 minutes this is the most valuable unused control in the product.** A
> researcher who thinks of something mid-run can queue it or steer it into the current turn. Nobody has
> been told it exists, and the default cannot be chosen.

### The composer's access-mode control — a closed hole, worth recording

`ui-conversation` renders a `PermissionSelect` in the composer tool row
(`ui-conversation/lib/client.js:15655-15752`) offering every row of the host's permission-presets table,
with `danger-full-access` behind a `RiskConfirmation` checkbox (`:15740-15751`). It escalates by
submitting a **slash command**:

```js
const submit = (id) => { setPick(id); command(`/permission ${id}`)… }
```

`ui-conversation/lib/client.js:15680-15684`. That is `command/execute` — **not an API method our deny
list covers**, and the control belongs to `ui-conversation`, which cannot be disabled.

**This is already closed, correctly, and for exactly this reason.** The hosted profile replaces the
presets table with **one row** (`apps/server/src/dshProfilePatch.mjs:449-471`), and the comment there
states the analysis verbatim: "the browser's composer offers every row of this table as an access mode,
and the switch travels as a `/permission <id>` command through the same prompt path a research question
takes — so a table that listed `danger-full-access` was a menu item away from an unconfined sandbox,
behind nothing but a checkbox. The runtime-UI deny list never covered it, because it is not an API
method. With one row there is nothing to switch to." (`dshProfilePatch.mjs:441-448`).

> **The general lesson, and it applies to everything else in this report:** the deny list classifies
> `/api/<ns>/<method>` (`runtimeUiSurface.mjs:203-209`), and **`command/execute` is a universal
> trampoline** — any host command becomes reachable from the composer without passing a namespace gate.
> The composition, not the deny list, is what bounds it. Any future decision to enable a native surface
> should ask which commands it exposes, not only which methods.

### Compaction

`ui-chat` renders compaction markers with `message.compaction` 「上下文已压缩」,
`.running` 「正在压缩…」, `.completed` 「已压缩 {items} 条历史记录（约 {tokens} tokens）」,
`.expand` 「点击查看压缩摘要」, `.unavailable`, `.commandTitle` `compact`
(`ui-chat/lib/client.js:2670-2675`). The live run compacted at ~320 K → ~135 K tokens
(`00-live-findings.md` F4), so this row is on screen in real runs and is un-reviewed copy.

### Images / attachments

Composer attachments, message images, trajectory images and tool-result images are all wired
(`ui-attachment` occupies all four seats). The image URL loader is session-authorised and shared —
"Image URLs use the Conversation-owned per-session cache, so Chat and Trajectory share one authorized
read per attachment" (`ui-trajectory/README.md`, Inspecting records). But **upload is denied**
(`runtimeUiSurface.mjs:102`, `:134-140`), so the intake half of the feature is closed while the
affordance remains.

### Export

**There is no export feature in any of the 47 client packages.** No key, no command, no button. Session
export lives entirely in our control plane (`GET /api/projects/:id/export`). Recording this explicitly
because it is the kind of thing one assumes the kernel has.

### Keyboard and accessibility

- Escape closes every popover and returns focus to its trigger (`ui-schedule/README.md`,
  `ui-jobs/README.md`, `ui-conversation/lib/client.js:4986`, `:14183`, `:15430`).
- The trigger menu keeps composer focus: rows pick on mousedown, the highlight rides
  `aria-activedescendant` (`ui-input-trigger/lib/client.js:907`, `:970`), Tab drills a `drill: true`
  candidate and passes through untouched without a highlight (`ui-input-trigger/README.md`, Keyboard and
  mouse).
- The subagent tree has full arrow-key navigation: ArrowRight/Left expand and collapse,
  ArrowUp/Down/Home/End/Escape navigate or close (`ui-subagent/README.md`, Browsing the tree).
- `ui-user-questions`: Enter continues and submits, Shift+Enter breaks a line, and during IME
  composition Enter only confirms the candidate (`ui-user-questions/README.md`, Use this package).
- `prefers-reduced-motion` is honoured in **12 packages** (grep over `/tmp/dshc/**/client.js`);
  `aria-live` regions appear in `ui-trajectory` (`:5386`, `:5426`) and `ui-settings-models` (`:1971`).
- The right sidebar's tab strip: only the native trigger button enters the tab order; the `listbox` role
  sits on the scrolling viewport rather than the bounded shell, "because a breadcrumb header is not an
  option and a listbox may not carry one" (`ui-input-trigger/README.md`, Understand the implementation).

### AppFrame breakpoints and narrow-window behaviour

From `ui-layout/README.md:28` and `ui-layout/lib/types/client/columns.d.ts:19-37`:
sidebar 264–420 px, default 280, 56 px rail when collapsed, **auto-collapse below 1024 px**; opening the
right panel collapses a manually expanded sidebar; the right panel opens at **45 %** of the viewport,
retains the user's pixel preference, capped at **70 %**, floor 300 px; to protect 400 px for the centre
the frame first shrinks the right panel to 300 px, then reports insufficient room so the occupant closes
it, and only then compresses the centre. Dragging has no transition delay; the right handle is absent
while closed or fullscreen. The right panel opens **fullscreen automatically below 768 px**
(`ui-sidebar-right/README.md:39`).

Known limits: "Extremely narrow windows — after the right panel closes, the centre may still fall below
400 px; the left 56 px rail remains" and "**No scroll anchoring during squeeze reflow** — layout changes
may move the reader's viewport" (`ui-layout/README.md:82-84`).

> That last one is very likely the explanation for the clipped conversation in screenshot
> `14-chat-right-panel.png` (`00-live-findings.md` F2). **And note the first one interacts with our
> CSS**: we hide `_sidebarCol` entirely (`runtimeUiShell.mjs:330`), so the frame's own "the left 56 px
> rail remains" guarantee does not hold for us and the squeeze math is operating on a column that is not
> drawn. Our measured grid (`280px 400px 528px` at 1440) shows the frame still reserving the sidebar
> track. **Unverified: whether the frame's insufficient-room close fires correctly with the track
> hidden.**

### `shell.overlay` — the app-wide floating seat, unused

Declared by `ui-layout` (`ui-layout/lib/types/client/index.d.ts`, `SlotMap` entry `shell.overlay`) and
described in the `root` doc as the sanctioned alternative to registering into `root`: "For a surface of
your own that floats over the whole app, register into `shell.overlay` instead (a **list** slot:
additive, and **click-through until your entry opts into pointer events**)"
(`ui-renderer/lib/types/client/registry.d.ts:26-30`). **Nothing occupies it.** It is the correct seat for
a frame-wide EviMed banner, a run-progress HUD, or a toast surface of our own.

### Miscellaneous unused seats

`sidebar.panellist`, `sidebar.settings`, `sidebar.footer.action` — all declared by `ui-sidebar`, which we
shadow with `Nothing`, so these are dead for us by construction (and `sidebar.panellist` is a **locale
key**, not a slot, per the standing memory note — the `.d.ts` confirms it is a real `SlotMap` entry at
`ui-sidebar/lib/types/client/contract/slots.d.ts:26`, so the note's wording is worth revisiting).
`conversation.chat.commandview` (keyed by command name) — a per-command row renderer, unoccupied.
`sidebar.right.tab.menu.item` (list) and `sidebar.right.tab.guide` (chain) — right-sidebar extension
seats, unoccupied.

---

## Final table — native capability → state in EviMed → recommendation → risk

Legend for **state**: `on` = renders; `starved` = enabled but its producer never fires; `disabled` = row
off in our profile; `denied` = its wire namespace/method is refused; `shadowed` = we occupy its slot with
nothing; `unused` = available and never registered into.

| # | Native capability | State in EviMed | Recommendation | Risk & wire methods needing allow-listing |
|---|---|---|---|---|
| 1 | **Right-sidebar tab types** (`ctx.sidebarRightTabs.register` + keyed `sidebar.right.pane.tab`) | unused → the 「开始」 guide is empty because **zero guide entries** are registered | **Wrap with our own occupant.** Register one or more EviMed tab types (交付物 / 证据矩阵 / 依据) fed by the control plane's scoped artifact APIs, each with a `guide` entry. `priority: 'extension'` outranks every shipped viewer. | None — no new wire method. The tab body is a pure React component; data comes through a service we inject. |
| 2 | `ui-sidebar-files` (workspace file tree) | disabled + `workspaceFiles` denied | **Enable + locale**, if a raw file tree is wanted. It contributes the one guide entry that makes the panel open into content. | Needs **`workspaceFiles/list`** allow-listed as a per-method exception. `list` **is** confined by upstream's `confine` helper (`runtimeUiSurface.mjs:81-88`); this is the low-risk half. |
| 3 | `ui-sidebar-documentpreview` (Markdown/code/image/PDF/HTML preview) | disabled + denied | **Keep off as-is.** Re-implement as an EviMed tab type reading through the control plane. | Would need `workspaceFiles/read`,`readAll`,`readRelated` — **unconfined by upstream's own documentation** (`runtimeUiSurface.mjs:81-88`). Do not open. 6.6 MB bundle. |
| 4 | `ui-deliverables` (produced-files turn tail) | starved ×3 — our writes go through `bash`, `present` is unmounted, and its click target is disabled | **Keep off / replace.** Register our own `conversation.chat.turnTail` chain entry fed by the run ledger. Consider deleting the row so its `ui:deliverable-file-references` system-prompt section (order 9000) stops riding every request prefix. | None for our replacement. Adopting it as-is would need `present` mounted **and** `workspaceFiles` opened. |
| 5 | **`tool.call.toolview` keyed per-tool views** | unused — every EviMed tool renders as `tool.title.generic` 「工具调用」 | **Wrap with our slot occupants.** Register `evimed_plan`, `evimed_delegate`, `evimed_submit_deliverable` first; then the high-frequency MCP tools. `block.argsRaw` streams, so a running call can show progress. **This is the direct answer to complaint #3.** | None — pure presentation, `key` domain is open, unclaimed keys fall back. Cost: it is a React component inside `runtimeUiShell.mjs`'s bundled body, which today has no build step. |
| 6 | `conversation.chat.node` keyed shadowing for `system-prompt` + `context` | unused | **Wrap with our slot occupant** returning `null`, gated on `__EVIMED_FRAME__`'s operator flag. This is the documented route to complaint #2's half about prompt exposure. | None. Do **not** use locale blanking: `provenance.label` (`@deepseek-ai/dsh-system-prompt`, `skill-catalog`) is data, not a key (`ui-chat/lib/client.js:865-874`). |
| 7 | `ui-trajectory` | operator-only | **Keep off for researchers, why:** no config, no per-row switch, all-or-nothing, and it renders the assembled system prompt and every tool call's raw JSON. Give researchers #5 instead. | None. Note: the row disable removes the tab, not the frames — the kernel still streams them (`dshProfilePatch.mjs:275-288`). |
| 8 | `ui-subagent` catalogue + lineage chip | **on and working** | **Enable + locale.** Unify 「subagent」/「子代理」/「子智能体」 to one term across `chat`, `subagent`, `workspace`, `slash.menu` (6 keys). | None. |
| 9 | Turn-process subagent counting | broken for us — `isSubagentDelegationTool` matches only `subagent` / `subagent_*` (`ui-chat/lib/client.js:1440`) | **Rename the tool** to `subagent_delegate`, or accept the count folding into 「N 次工具调用」. A rename is a zero-plugin fix. | Renaming a socket tool touches `packages/domain/src/toolNames.mjs:105-116`, the skill bodies, and the gate's leakage token list (`:214-219`). Not free — evaluate against #5. |
| 10 | `ui-workflow-run` (run → phase → member disclosure) | starved — only `dsh-tool-workflow` emits its records | **Keep off, why:** adopting it means routing delegation through the kernel's `workflow` tool, which does not carry deliverable ids or gate rounds. **Copy its shape** in #5 instead. | None. |
| 11 | `ui-jobs` (background-job header list) | starved — our bash calls are foreground | **Keep as-is**, but consider running long analysis scripts through `job_run` so the header badge becomes a live progress surface for free. | None — `job_run`/`job_status` are already mounted (`toolNames.mjs:243`). |
| 12 | `ui-plan` chip + `plan-review` question intent | on but never triggered | **Enable + wrap.** Have `evimed_plan` raise an `ask_user_question` with the `plan-review` intent to get the native plan card (strip + scrolling markdown + Chat about it / Refuse / Approve) for free. | None — `ask_user` is mounted; `ui-user-questions` is on. Changes run behaviour: a plan pause is a new blocking point → principle 4/20 apply. |
| 13 | **`/` command contributions** (`ctx.commandUi.register`) | unused; the 15 capabilities are a `<details>` pill row | **Wrap with our occupant.** One `popupSelect` command (15 `SelectOption` rows) replaces the pill row. **This is the answer to complaint #4.** | None new. Needs `@deepseek-ai/dsh-client-ui-commands` in `packages/socket/package.json` → `dsh.client.inject`. Name must not collide with a host command — a collision **fails loud** (`ui-commands/lib/types/client/contract.d.ts:47-51`). |
| 14 | **`@` reference sources** (`ctx.inputTriggers.registerSource`) | unused for our data | **Wrap with our occupant.** An `@` source over the knowledge base (`src_<sha256>` from `sourceService.mjs`), with `codec.serialize` expanding the reference for the model. | None — zero new wire methods if candidates come from our own service. |
| 15 | `conversation.input.left` / `.right` (composer tool row) | unused empty list slots | **Available.** The natural seat for a compact EviMed control; better than `input.dock` for anything small. | None. |
| 16 | `conversation.chat.assistant-actions` (list) | unused (its only occupant, `ui-message-feedback`, is disabled) | **Available** for 「查看依据」 / 「导出」 per assistant message. | None. |
| 17 | `shell.overlay` (list, click-through) | unused | **Available** — the sanctioned frame-wide floating seat (`ui-renderer/lib/types/client/registry.d.ts:26-30`). Candidate home for a run-progress HUD. | None. |
| 18 | **Theme `ctx.theme.overrideTokens`** | unused — frame is DeepSeek blue, shell is rust/beige | **Wrap with our occupant.** Override the six `--dsw-static-deepseek-*` steps + `--dsw-font-family` + the ~6 focus-ring aliases. **This is the answer to complaint #5.** | None — validation is shape-only (`ui-theme/lib/client.js:1430-1442`). Needs `@deepseek-ai/dsh-client-ui-theme` injected. Cannot reach hard-coded radii/`#fff` glyph — keep the stylesheet for those. |
| 19 | Host `ui-theme` settings (`preference`, `fontSize`) | unset; and `settings` is denied so the user cannot change it | **Enable** by pinning a deployment default in the profile, for a flash-free first paint. | None. Reaches two scalars only; **not** a palette. Off loopback the scope is memory-only (`ui-settings/lib/client.js:1345`). |
| 20 | `ui-chat` `transcriptView` Normal/Compact | default `compact`, unreachable (settings denied + panel disabled) | **Keep default.** Compact is right, and it does **not** hide the system-prompt row — use #6. | Setting a host default is possible in principle (an ordinary settings-document section). **Unverified from these files** whether `dshProfilePatch.mjs` reaches that document. |
| 21 | **Session fork / branch** (`session/fork`) | **on, working, unaccounted for** | **Investigate first.** A forked session gets no project row, no run ledger entry, and no shell navigation. Either account for it or hide the affordance. | `session/fork` is **not denied** today. Decide deliberately rather than by omission. |
| 22 | **Composer queue / steer** (`session/updateQueue`) | on, undiscovered; its preference row is unreachable | **Enable + locale + surface it.** For 8–28-minute runs this is the highest-value unused control. Pin the deployment default. | `session/updateQueue` is **not denied** — already reachable. Zero new exposure. |
| 23 | Turn-navigation rail | on but degraded — `dsh-session-turn-outline` is not composed; also hidden below a 900 px container | **Enable** the host projection row, and re-check the rail against our 680 px centre column. | None — a host composition row, no browser method. |
| 24 | Session search (`session/search`) | shipped, **unreachable** — it lives in the left column we replace | **Wrap with our occupant** or move the capability into the shell's own 会话 list. | `session/search` is not denied. |
| 25 | `ui-goal` / GoalBar | disabled + `goals` denied | **Keep off, why:** cross-day scheduling the control plane does not know about (`runtimeUiSurface.mjs:50`); autopilot agendas are our equivalent. | — |
| 26 | `ui-schedule` | disabled **in the base image itself** | **Keep off, why:** needs the host `@deepseek-ai/dsh-schedule` overlay too; autopilot covers it. | — |
| 27 | `ui-message-feedback` | disabled + both namespaces denied | **Keep off, why:** it is an upstream channel out of the deployment (`runtimeUiSurface.mjs:54-55`). If per-message feedback is wanted, use `conversation.chat.assistant-actions` (#16) with our own store. | — |
| 28 | `ui-model-selection`, `ui-agent-preset`, `ui-settings-*`, `ui-cordis`, `ui-open-in-app`, `ui-brand-official`, directory pickers | disabled / not-composed, each with a paired method ban | **Keep off** — all correctly closed, each with a pairing recorded in `test/hiddenPanelsHaveAMethodBan.test.mjs`. | — |
| 29 | Composer access-mode control (`/permission`) | **on** — but the presets table is one row | **Keep as-is.** Already closed at the composition, which is the only place it could be closed. | Records the general lesson: **`command/execute` is a trampoline the method deny list does not cover** (`dshProfilePatch.mjs:441-448`). |
| 30 | Attachments / upload | render path on, **upload denied** | **Decide.** Either hide the composer's attachment affordance or route uploads through `sourceService`. Today the button exists and the POST is refused. | `fileUploads/*` and `session/uploadFileBinary` denied (`runtimeUiSurface.mjs:102`, `:134-140`); the `file-upload` **row must stay mounted** or the session controller never starts (`:95-98`). **Unverified: what the user sees on refusal.** |
| 31 | Export | **does not exist upstream** | Nothing to enable. Ours is the only export. | — |

### Cross-cutting notes

1. **Six of the recommendations are the same change**: add one or two services to
   `packages/socket/package.json` → `dsh.client.inject` and register more occupants in
   `packages/harness-port/src/runtimeUiShell.mjs`. That file is bundled by
   `packages/socket/scripts/build-client.mjs:19-30` as `apply.toString()`, so **nothing in it may close
   over a module import** (`runtimeUiShell.mjs:45-49`). Growing it from ~340 lines of cosmetics to a
   real UI layer with React components is a build-shape decision that should be made once, up front.
2. **Slot-kind mistakes are silent.** A list slot needs `id`, a keyed slot needs `key`, a single slot
   needs a `priority` below `0`, and every one of these has already cost this codebase a shipped
   no-op (`runtimeUiShell.mjs:152-165`, `:219-226`). A registration helper that fails loudly per kind
   would pay for itself.
3. **Disabling a row un-declares its slots.** `conversation.hero.agentPreset` is the worked example; the
   mechanism is that a slot's declaration is committed by the `register()` that owns the parent seat
   (`ui-renderer/lib/types/client/registry.d.ts:84-100`) and `inject` simply never fires. Any plan that
   occupies a slot must first check that the declaring row is enabled.
4. **What cannot be determined from `/tmp/dshc`**: the contents of
   `@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/dsh-client-ui-slots` (not extracted); the
   host shell `@deepseek-ai/dsh-host-webserver` (so the 16 px body font's owner); the agent preset's
   tool roster (so whether `present` could be mounted); and whether the profile patch can write the
   `ui-chat` settings-document section.
