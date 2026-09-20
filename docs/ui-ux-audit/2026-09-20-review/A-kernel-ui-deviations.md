# A — Every deviation from the native DSH web UI (read-only code audit, 2026-09-20)

Produced by a read-only sub-investigation for `../2026-09-20-产品现状根因分析与一次性整改方案.md`. File and line references are as of commit 70683e97a.

# EviMed ↔ DSH web-UI deviation audit

## A. Every deviation from native DSH

**Slots we occupy** (all via `kit.occupy`, `runtimeUiKit.mjs:387-423`)

| Slot | Occupant | Where |
|---|---|---|
| `sidebar` (whole left column) | `LeftColumn` → renders `null`, also force-calls `layout.toggleSidebar()` so the frame's room arithmetic counts 56 px | `runtimeUiShell.mjs:218-225` |
| `sidebar.brand.mark` / `.name` | EviMed `Mark`/`Name` — dead by the file's own admission while the column is shadowed | `runtimeUiShell.mjs:200-203`, rationale `:20-26` |
| `conversation.hero.brand.mark` | `Mark` | `runtimeUiShell.mjs:204` |
| `conversation.hero.workspace` | `Nothing` | `runtimeUiShell.mjs:228` |
| `conversation.input.attachments` | `Nothing` | `runtimeUiShell.mjs:233` |
| `conversation.hero.agentPreset` | the four role cards | `runtimeUiCommands.mjs:220` |
| `conversation.input.dock` (`evimed-busy-hint`) | 「运行中：Enter 排队 · Ctrl/⌘+Enter 插话」 | `runtimeUiControls.mjs:33,56` |
| `conversation.chat.node` keys `system-prompt`, `context` | `null` / recall-only passthrough | `runtimeUiTranscript.mjs:70-71` |
| `tool.call.toolview` keys `evimed_plan`, `evimed_delegate`, `evimed_await`, `evimed_submit_deliverable`, `evimed_package_check`, `evimed_claim_upsert` | six custom cards | `runtimeUiToolviews.mjs:568-579` |
| `sidebar.right.pane.tab` keys `evimed-progress/-deliverables/-evidence/-sources` | four tab bodies | `runtimeUiPanels.mjs:359-362` |

**Native client rows disabled** — `HOSTED_DISABLED_BROWSER_PANELS`, `dshProfilePatch.mjs:342-405`, written at `:300-311`: `ui-settings-general/-models/-plugin-inventory/-plugins`, `ui-model-selection`, `ui-permission`, `ui-agent-preset`, `ui-message-feedback`, `ui-goal`, `ui-cordis`, `ui-brand-official` (`:347-362`, reason `:273-296`: hosted users own a project, not the deployment); `ui-open-in-app`, **`ui-sidebar-files`** (`:369`), **`ui-sidebar-documentpreview`** (`:370`) — reason `:363-367`; `cordis-client-runner` (`:379`, two 403s per session open); `command-feedback` (`:396`, `/feedback` dead-ends); `session-log-download` (`:404`, `/export` 400s). Operator-only: `ui-trajectory` (`:330-332`) — **this is the "process page" that is lost** for researchers; the reason recorded is English prompt exposure (`:314-328`).

**Locale overrides** — `runtimeUiLocale.mjs:56-110`: a private language `zh-x-evimed` is *forced* (`:44,143,148`) and `<html lang>` rewritten to `zh-CN` (`:139`); keys in `conversation` (hero headline, both placeholders, `hero.preview`→`''`), `chat` (`deepDiving`, turnProcess subagent counts, maxTokens, auth failure), `subagent` (13 keys, 子代理/子智能体→子任务), `workspace`, `slash.menu`, `common.brand.localBuild`.

**CSS injected** (`runtimeUiShell.mjs:81-149`, one `<style>` at `:256-261`): hide Add-workspace button `:86`; hide empty preview badge `:88`; hide hero workspace chip `:100`; hide composer paperclip `:108`; `display:none` the sidebar column + re-grid the three columns + hide a resize handle `:127-130`; two overflow clamps `:147-148`.

**Theme** — ~60 `--dsw-*` tokens replaced as one layer (`runtimeUiTheme.mjs:64-171`, source `@evimed/dsh-socket` `:58`), re-applied up to 5× if a `theme/change` drops it (`:201-208`), plus `setTheme` driven from the shell (`:211-217`).

**`/` menu** — with `command-feedback` and `session-log-download` disabled and `permission` isolated from `commands` (`dshProfilePatch.mjs:531-543`), a live probe found the menu contains **only our `/能力`** (`:382-385`; registered `runtimeUiCommands.mjs:171-187`).

**Denied wire namespaces that kill native features** — `runtimeUiSurface.mjs:57-104`: `workspaceFiles` (kills the Files tree *and* every preview), `fileUploads` + `session/uploadFileBinary` (`:140`), `settings` (kills `transcriptView`, see D), `llm`, `credentials`, `directoryPicker`, `goals`, `agentTeams`, `cordis`/`dynamicCordisRunner`, `messageFeedback`/`sessionFeedback`; per-method: `agentPresets/select|copy|deletePreset`, `session/selectModel|modelCatalog|openWorkspacePath`, `workspace/create|delete|rename|archiveSession|…` (`:113-141`).

## B. The blank-session hero

Defined once, `runtimeUiCommands.mjs:72-86`: four hard-coded `{role, text, capabilityId}` pairs — 临床问题→`clinical-evidence-synthesis`, 药物评价→`comprehensive-drug-evaluation`, 选题与申报→`research-topic-selection`, 数据可行性→`dataset-research-scoping`. A card is dropped if that capability is absent from the frame's catalogue (`:80-85`). Rendered as a grid of buttons into `conversation.hero.agentPreset` (`:194-220`).

Clicking: `fill(currentSessionId, card.brief)` (`:201` → `:158-165`). It **does not navigate** when a session is open — it calls `ctx.conversation.input.for(scope).setDraft(entry.brief)`, i.e. it overwrites the composer draft with the capability's **`brief`** (the full catalogue brief, up to 100 000 chars per `runtimeUiKit.mjs:50`), *not* the card's own one-line `text`. With no current session it leaves the frame: `__EVIMED_SHELL__.navigate('new-task', brief)` (`runtimeUiBridge.mjs:345,363-367`).

**No capability cards exist in the hero.** The 15-capability catalogue is reachable only through the `/能力` popup (`runtimeUiCommands.mjs:48-61,167-188`). The hero shows only these four role restatements, which is the owner's complaint (3).

## C. The right panel

Registered tab types — `runtimeUiPanels.mjs:45-52` (ids/titles/descriptions) and `:364-374`:

| id = kind | title | guide entry | body |
|---|---|---|---|
| `evimed-progress` | 进展 | `order: 10`, 「每件交付物做到哪一步、用了多久」 | `ProgressTab` `:267-300` |
| `evimed-deliverables` | 交付物 | `order: 11` | `DeliverablesTab` `:302-315` |
| `evimed-evidence` | 依据 | `order: 12` | `EvidenceTab` `:317-337` |
| `evimed-sources` | 来源 | `order: 13` | `SourcesTab` `:339-357` |

All `priority: 'extension'`, page types (no address patterns). Data comes **entirely from the shell over postMessage** — `run-state` and `evidence` validated in `runtimeUiBridge.mjs:250-273`, stored in the hub (`runtimeUiKit.mjs:165-169`), read via `kit.useFrameState` (`runtimeUiPanels.mjs:252-257`) and gated to the session on screen by `liveRunFor` (`runtimeUiToolviews.mjs:112-118`). The frame reads no file (`runtimeUiPanels.mjs:23-24`); 「打开」 posts `open-artifact` to the shell (`:263-265,314`).

**Why 「开始」 + 「+」.** `ui-sidebar-right`'s default-page rule: *exactly one* guide entry opens that page directly, **zero or multiple open the guide** (inventory §T1 `:207-209`). We contribute **four**, so the guide is now the default page on every session; its title is the kernel's `sidebarRight/tab.guide.title` = 「开始」, and 「+ 新标签页」 is `dock.addTab`, which calls `openTab('guide')` — i.e. the 「+」 re-opens the same compass, it starts nothing (inventory `:193-218`). The guide has no words of its own; the four capsules a user sees are our own `description` strings.

**Automatic open** — `runtimeUiPanels.mjs:376-402`: 进展 opens once per run when `state==='running'` **and** the run has children/delegated deliverables (`:393-395`); 交付物 opens once when a report/matrix first appears for a run that was watched before it had one (`:396-398`). `openTab` throws with no seat mounted and is retried on the next hub change (`:385,400`).

**Per-session / no run.** Surface state is one per session id and **memory-only** — a reload collapses every session; there is **no right surface at all without a session**, so the blank hero has none (inventory `:184-186,292-303`). In a session with no bound run each body renders its own empty line (`:277,305,322,343`) — but the *default* view is still the 开始 compass.

**Natively the right panel is**: the workspace **Files tree** (`ui-sidebar-files`, kind `files`, one guide entry at `order:10`) plus **document-preview tabs** (`ui-sidebar-documentpreview`: markdown/code/image/PDF/HTML/text, 6.6 MB) opened by `dsh-resource://file/**` addresses from `ui-chat` file links (inventory `:305-347`). Both are disabled (`dshProfilePatch.mjs:369-370`) because they call `workspaceFiles`, a denied namespace whose `read/readAll/readBytes/stat` never confine to the workspace (`runtimeUiSurface.mjs:65,81-101`). Note `workspaceFiles/list` **is** confined — re-enabling the tree alone is a one-method exception.

## D. In-transcript cards

- **「研究计划」** = `PlanView` on `tool.call.toolview` key `evimed_plan` (`runtimeUiToolviews.mjs:464-489,569`; name from `SOCKET_TOOL_NAMES.plan`, `toolNames.mjs:126`). Headings at `:469-472`; statuses are taken from the *live* run, never the call's own snapshot (`:150-156,177`).
- **「子任务」** = `DelegateView`, key `evimed_delegate` (`:492-519,570`). Shows title, capability, state pill, ticking elapsed, run phase and source counts (only when a single child is running, `:280-288`), attempt + verdict.
- **「查看子任务」** = `childLinkFor` (`:384-420`), shared by the card (`:517`) and the 进展 tab (`runtimeUiPanels.mjs:298`). It calls `ctx.sessions.openSubagent({parentSessionId, childSessionId, mode})` (`:410`) and stays disabled until the parent's subagent catalogue lists that child with `kind:'child'` (`:399-401`), asking `refreshSubagents` once (`:403-407`). It **replaces the view** with the child's own conversation.
- **Parent transcript while a child runs**: only our delegate card. DSH has no inline child-activity surface (inventory `:519-526`). Worse, the native turn-process subagent counter matches only `subagent`/`subagent_*`, so `evimed_delegate` is counted as an ordinary tool (inventory `:532-538`) — making our overridden strings `message.turnProcess.subagents.*` (`runtimeUiLocale.mjs:73-74`) effectively unreachable.
- **A child's own transcript** is reached only through that button or the session-header subagent chip; the ordinary session list omits subagent conversations (inventory `:525-526`). It is the kernel's full transcript for the child; the bridge reports `subagent:true` + `rootSessionId` to the shell (`runtimeUiBridge.mjs:145-162,171-172`) and `liveRunFor` keeps the same run state valid there.
- **思考 / 工具调用 rows are compact — and we did not choose it.** `transcriptView` defaults to `compact` (inventory `:617-628`); its only control is a `ui-settings-general` row, disabled (`dshProfilePatch.mjs:347`), and the `settings` namespace is denied (`runtimeUiSurface.mjs:59`), so it can never be written from the page. **Nothing in this repo sets `transcriptView`** (no occurrence). Compact folds the turn's process rows behind one control at `turn/end`; `system-prompt` is excluded from folding upstream, which is why `runtimeUiTranscript.mjs:70` hides it by slot instead.

## E. Dead, contradictory, duplicated

- `sidebar.right.pane.tab.title` is declared in the pinned table (`runtimeUiSlots.mjs:94`) but **never occupied** — titles are static (`runtimeUiPanels.mjs:370`). Same for `conversation.input.right` (`runtimeUiSlots.mjs:87`), used only in tests.
- `kit.css` (`runtimeUiKit.mjs:429-437`) is never called; the only stylesheet is hand-built in `runtimeUiShell.mjs:256-261`. `kit.embedded` (`:474`) is never read. `RUNTIME_UI_OPTIONAL_SERVICES`/`_REQUIRED_SERVICES` are consumed only by a test.
- **Two mechanisms for one hide, three times**: hero workspace picker occupied with `Nothing` *and* the chip hidden by CSS (`runtimeUiShell.mjs:228` + `:100`); attachments strip occupied with `Nothing` *and* the paperclip hidden by CSS (`:233` + `:108`); `hero.preview` blanked in the locale pack (`runtimeUiLocale.mjs:59`) *and* the empty badge hidden by CSS (`runtimeUiShell.mjs:88`).
- Sidebar brand occupants (`runtimeUiShell.mjs:201-202`) are dead code the file itself labels dead (`:20-26`).
- `runtimeUiSurface.mjs` lists **`workspaceFiles` twice** (`:65`, `:101`) and **`sessionFeedback` twice** (`:67`, `:103`); Set-deduped, but the second block's prose reads as if introducing them.
- `useLive()` is defined identically twice (`runtimeUiPanels.mjs:252-256`, `runtimeUiToolviews.mjs:443-447`); `toolviewText/verdictText/liveRunFor/childLinkFor` are emitted into two closures (`runtimeUiPanels.mjs:409`). Three parallel state vocabularies: `runStateText` (`runtimeUiPanels.mjs:59-66`), `status` and `childState` (`runtimeUiToolviews.mjs:49-54`).
- `runtimeUiPanels.mjs:28-30` claims the panel opens on its own "at two moments"; in fact registering four guide entries makes the 开始 guide the default page on **every** session — the module note never records that side effect.
- `artifactModel(live)` is recomputed in the auto-open check (`:396`) and again in the tab.
- **Internal/foreign vocabulary shown to users**: 「在**内核**的子任务视图中…」 tooltip (`runtimeUiToolviews.mjs:416`); contract words 交付物 / 主张 / 核验 / 未核验 surfaced as tab titles and pills (`runtimeUiPanels.mjs:47-51`, `runtimeUiToolviews.mjs:49-54`); the unreachable kernel notice 「这类内容还没有可用的查看方式。」 (inventory `:224-227`); `ui-deliverables` still injects an English system-prompt section for a row that never renders (inventory `:380-386`).
