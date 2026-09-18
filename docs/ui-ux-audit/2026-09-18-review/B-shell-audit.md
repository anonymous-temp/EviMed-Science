# B — Shell front-end / UX audit (read-only, 2026-09-18)

Scope: the EviMed shell `OpenScience/apps/web` (React + Vite + Tailwind), its server boundary
`OpenScience/apps/server/src`, the kernel-client customisation `packages/harness-port/src/runtimeUiShell.mjs`,
and the design tokens in `apps/web/src/index.css`.

Built on the production measurements in `outputs/product-review-2026-09-18/00-live-findings.md`
(release `evimed-3dc0fa10cd25-1`, kernel client 0.1.5-rc.2) — those facts are not re-measured here.
Screenshots: `docs/ui-ux-audit/2026-09-18-walk/`.

All paths are relative to `/home/coder/workspace/EviMedScience/OpenScience` unless stated.

Status: COMPLETE.

- [x] Section 1 — the owner's eight complaints: root cause + fix
- [x] Section 2 — tokens, contrast, brand, typography
- [x] Section 3 — per-route findings (P0/P1/P2)
- [x] Section 4 — earlier-audit items still not done
- [x] Section 5 — the 15 highest-leverage shell changes

---

# Section 1 — the owner's complaints: root cause and fix

## 1. The inbox bell badge, and what the inbox says

### 1a. Geometry — root cause

`apps/web/src/components/sidebar/Sidebar.tsx:173-185`:

```tsx
<button … className="relative ml-auto self-center rounded p-1 text-text hover:bg-surface-2">
  <Bell size={14} strokeWidth={1.5} aria-hidden="true" />
  {unread > 0 && (
    <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center
                     rounded-full bg-accent px-1 text-caption font-medium text-accent-fg">
      {unread > 99 ? "99+" : unread}
    </span>
  )}
</button>
```

Four compounding causes, all in those four lines:

1. **The badge is as large as the icon.** `Bell size={14}` is a 14×14 glyph; the badge is
   `h-3.5` = 14 px tall and `min-w-3.5` = 14 px wide, growing to ~22 px at two digits
   (measured, F7). A 14 px badge cannot sit *beside* a 14 px icon — it covers it.
2. **The offset pulls it inward, not outward.** `-right-0.5 -top-0.5` is −2 px. The button's
   padding is `p-1` = 4 px, so the badge's −2 px offset still lands *inside* the button box,
   on top of the glyph. A badge meant to hang off a control needs an offset larger than the
   control's padding.
3. **The type rung does not fit the box.** `text-caption` is `["12px", "1.5"]`
   (`apps/web/tailwind.config.js:39`) → an 18 px line box inside a 14 px-tall element. The
   `grid place-items-center` recentres it, but the glyph is drawn at 12 px in a 14 px circle,
   so there is ~1 px of ring left and nothing separating badge from icon.
4. **No separating ring.** The badge is `bg-accent` (#B24F2A) directly against the bell's
   `text-text` strokes with no `ring`/`border` in the surface colour, so the two shapes merge.

### 1b. Geometry — the fix

```tsx
<button aria-label={…} className="relative ml-auto self-center rounded p-1.5 text-text hover:bg-surface-2">
  <Bell size={16} strokeWidth={1.5} aria-hidden="true" />
  {unread > 0 && (
    <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full
                     bg-accent px-1 text-[11px] leading-none font-medium text-accent-fg
                     ring-2 ring-surface tabular-nums">
      {unread > 9 ? "9+" : unread}
    </span>
  )}
</button>
```

- icon 14 → **16 px**, button padding `p-1` → `p-1.5` (hit target 28×28, closer to the 24 px
  minimum the design spec's touch rule implies and matching the `PanelLeft` button beside it);
- badge **16 px** (`h-4 min-w-4`) offset **−4 px** (`-right-1 -top-1`) so it hangs off the
  button's corner instead of over the glyph;
- `ring-2 ring-surface` — the sidebar's background is `bg-surface`
  (`Sidebar.tsx:165`), so a 2 px ring in that colour cuts the badge free of the icon;
- `9+` instead of `99+`: with the count capped at 50 by the API (see 1c) the three-glyph branch
  is unreachable anyway, and a two-glyph maximum keeps the badge circular;
- `text-[11px] leading-none` needs a token, not an arbitrary value (ESLint bans
  `text-[Npx]` under `apps/web/src/**`). **Add a seventh rung** to
  `apps/web/tailwind.config.js:38-45`: `badge: ["11px", "1"]`, and use `text-badge`. That is the
  single-token change that makes this fixable without an `eslint-disable`.

### 1c. The count itself is wrong above 50

`Sidebar.tsx:80` computes the badge from the **length of one page**:

```tsx
listInbox({ unread: true }).then((page) => { if (active) setUnread(page.items.length); })
```

`listInbox` sends no `limit` (`apps/web/src/lib/inboxClient.ts:39-43`), the route defaults to
`limit = 50` (`apps/server/src/notificationRoutes.mjs:39`) and the service caps it at 100
(`apps/server/src/notificationService.mjs:215`). So:

- the badge **saturates at 50** and can never show a true count above it;
- `unread > 99 ? "99+"` (`Sidebar.tsx:182`) is dead code;
- to render one integer the sidebar downloads up to 50 full rows — `body` is up to 8 000 chars
  (`apps/server/src/notificationPersistence.mjs:12`) — every 60 s (`Sidebar.tsx:86`).

**Fix:** add a count to the list envelope (`notificationService.mjs:236-238` already runs one
query; a second `count(*) … WHERE read_at IS NULL` is cheap and `inbox_account_order_idx`
covers it), expose it as `unreadTotal` on `InboxPageResult`, and have the sidebar call
`listInbox({ unread: true, limit: 1 })` and read `unreadTotal`. Render `99+` above 99 then.

### 1d. What produces inbox items

Six producers, all confirmed by call site:

| Producer | path:line | type |
|---|---|---|
| run finished | `apps/server/src/server.mjs:1376-1402` using `runFinishedNotice` (`notificationService.mjs:111-141`) | `notify` |
| method approved / retired | `apps/server/src/learningService.mjs:401-404`, `:422-425` | `notify` |
| nightly method consolidation | `apps/server/src/methodConsolidation.mjs:638-652`, `:655-669` | `notify` |
| autopilot digest | `apps/server/src/autopilotService.mjs:1038-1043` | `review` |
| autopilot claim refuted | `apps/server/src/autopilotService.mjs:806-815` | `question` |
| memory value rewritten | `apps/server/src/memoryIntelligence.mjs:804-830` | `notify` |

**Do automated runs spam it?** Partly.

- **Learning-evaluation runs are suppressed** — `server.mjs:1292` sets
  `evaluationRun = runtimeManager.evaluationMethodSnapshots.has(runtimeManager.key(project))`
  and `server.mjs:1376` gates the notify on `!evaluationRun`. The flag is set only by
  `apps/server/src/learningEvaluation.mjs:110`.
- **Every other automated run does notify.** `evals/` harnesses dispatch through the ordinary
  run path, so each eval cell produces a 「研究已完成」 item. The memory-ablation batches (v1–v11,
  ~12 cells each) are exactly this: the walk found 31 unread items on `cdss-access`, and
  deleting 18 test projects took it to 2 (00-live-findings, "Done") — i.e. **29 of 31 unread
  items were machine-generated**.
- **Autopilot episodes notify twice**: the `review` digest (`autopilotService.mjs:1038`) plus
  the ordinary run-finished `notify`, because `autopilotWorker.mjs` dispatches through
  `onRunFinished` (`server.mjs:1352-1375` sits directly above the inbox block at `:1376`).
- **Nothing ever deletes an inbox row.** There is no `DELETE FROM evimed_inbox.notifications`
  anywhere; the only sweeper is `applyDueDefaults` (`notificationService.mjs:275-286`, every
  30 s from `server.mjs:3695-3698`) and it only *resolves* due items. Rows leave only by
  user/project FK cascade (`notificationPersistence.mjs:26`).

**Fix:** (i) suppress `notify` for any run whose dispatch came from an eval or autopilot
harness, not just the learning-evaluation snapshot — one `automated: true` flag on the dispatch
input, read at `server.mjs:1376`; (ii) coalesce run-finished notices by day using the existing
group-key mechanism (`notificationService.mjs:184-198`) with `groupKey = \`run-finished:${day}\``
so ten runs in an afternoon are one item saying 「今天完成 10 项研究」; (iii) add a retention
job beside `applyDueDefaults` deleting `notify` rows that are read and older than 90 days.

### 1e. There is no mark-all-read

The route table is exhaustive at `apps/server/src/notificationRoutes.mjs:34-59`: list,
preferences GET/PATCH, `POST /api/inbox/:id/read`, `POST /api/inbox/:id/resolve`, else 404.
Marking N items read is N requests, **each needing that item's fresh `expectedRevision`**
(`notificationService.mjs:246-248`). And the page only offers 「标为已读」 when the item has no
actions at all (`apps/web/src/app/routes/InboxPage.tsx:154`:
`{!item.readAt && item.actions.length === 0 && …}`) — every run-finished item carries an
`open` action (`server.mjs:1382`), so **the most common item in the inbox has no way to be
marked read from the UI at all**. It can only leave the unread filter by being resolved, which
for a run notice means clicking through to the run.

**Fix:** `POST /api/inbox/read-all` (optionally `?noticeType=notify`) doing
`UPDATE … SET read_at = coalesce(read_at, clock_timestamp()), revision = revision + 1
 WHERE user_id = $1 AND read_at IS NULL` — no revision precondition, because "mark everything
read" is idempotent and does not need optimistic locking. Surface it as 「全部标为已读」 beside
the `SegmentedControl` at `InboxPage.tsx:93-94`, and drop the `item.actions.length === 0`
condition at `:154` so any unread item can be marked read.

### 1f. Raw English validator text in the body — root cause

The chain, end to end:

1. **Producer.** `packages/domain/src/clinicalEvidence.mjs:3211-3215` —
   ``issues.push(`${label}.claim numeric fact ${token} is not present in its direct support. …`)``
   with `label` from `:3126` (`` `claims[${index}]` ``). Siblings at `:2884`, `:2891`, `:3193`,
   `:3334`, `:3349`.
2. **Severity split.** `apps/server/src/agentRuns.mjs:2225-2243` builds `qualityIssues` as
   `SAFETY — …`, then `MUST FIX — …`, then **`...rest` un-prefixed**. The numeric-fact string is
   degradable bookkeeping (`clinicalEvidence.mjs:1497`), so it lands in `rest` — raw English,
   no prefix.
3. **Storage.** `agentRuns.mjs:4144`/`:4156` → `run.qualityNotices`, normalised to ≤40 items of
   ≤300 chars (`agentRuns.mjs:76-77`, `:203-209`).
4. **Inbox body.** `apps/server/src/notificationService.mjs:134-139`:

```js
const body = [
  reason,
  files > 0 ? `本次运行产出 ${files} 个文件，仍在工作区里，可以直接打开。` : null,
  ...(run?.qualityNotices ?? []).slice(0, 2).map((notice) => String(notice).slice(0, 200)),
].filter(Boolean).join("\n");
```

So: the first two notices verbatim, each cut at 200 chars — **shorter than the 300-char store
cap**, so the inbox routinely shows a sentence cut mid-word that the run page shows whole.

The title 「研究已完成」 is `notificationService.mjs:115-123` (a seven-outcome table keyed on
`errorCodeOutcome`), the first body line is `:124-130`.

The frontend *does* have a grouper for these strings — `summarizeQualityNotices` /
`NOTICE_GROUPS` (`apps/web/src/lib/runPresentation.ts:213-282`) turns them into Chinese group
labels and strips the `MUST FIX — `/`SAFETY — ` prefixes at `:266` — but **the inbox body never
passes through it**; `InboxPage.tsx:128` renders `item.body` as pre-wrapped text.

### 1g. How a notification body should be written for a clinician — the fix

Rule: *an inbox body states what happened to the researcher's work and what they may do about
it; it never quotes a machine-to-machine repair instruction.*

Concretely, replace `notificationService.mjs:134-139` with a body built from **counts and
kinds, not sentences**, using the same vocabulary the run page already has:

```
研究结果已交付，但有 3 项自证没有通过，其中 1 项涉及临床安全。
本次产出 4 个文件，可直接打开阅读。
引用前请在报告里核对带 ⚠ 的结论。
```

Implementation: move `NOTICE_GROUPS` + `summarizeQualityNotices` out of
`apps/web/src/lib/runPresentation.ts:213-282` into `@evimed/domain` (they are a reader-facing
vocabulary, which is what the domain is for), call it from `runFinishedNotice`, and emit
`safety` / `mustFix` / `advisory` counts plus at most the two **group labels** — never the
validator sentence. The detail stays where it is actionable: on the run row, one click away
through the `open` action the item already carries.

Two smaller wording defects in the same function:

- `notificationService.mjs:127` — 「结果已交付，但有质量检查没有通过，需要你自己复核后再使用。」
  says "you must review it yourself" without saying what to look at. The report's 「依据」
  popover is exactly that surface; name it.
- `notificationService.mjs:120` — 「交付物未通过质量门」 uses 「质量门」, an engineering term.
  The rest of the product says 「核验」 (`RunsPage.tsx:665`, `:769`). Pick one; 「核验」 is the
  clinician-facing one.

---

## 2. "Default Project"

### 2a. Where the name comes from

Two hard-coded English literals, both in the control plane:

- `apps/server/src/store.mjs:571` — `return this.projectFor(user, "default", "Default Project");`
  (filesystem store)
- `apps/server/src/store.mjs:1035` —
  `INSERT INTO …projects(user_id, id, name, quota_bytes) VALUES ($1, 'default', 'Default Project', $2)`
  (Postgres store, `ensureDefaultProject`)

Nothing else names it. `ProjectSwitcher` renders `current?.name ?? currentId`
(`apps/web/src/components/sidebar/ProjectSwitcher.tsx:48`), so the English string is what the
first thing under the wordmark says in a Simplified-Chinese product.

### 2b. There is no rename route

`apps/server/src/server.mjs` has `GET /api/projects` (`:2998`), `POST /api/projects` (`:3004`),
`GET /api/projects/:id/export` (`:3035`), `DELETE /api/projects/:id` (`:3044`). No `PATCH`/`PUT`
handler exists for a project (`grep 'PATCH' server.mjs` hits only the CORS header at `:288`, the
method table at `:493`, a comment at `:724`, and the research-session/connector `PUT`s).
`store.createProject` accepts a name (`store.mjs:508`, `:1075-1087`) and the route validates one
up to 128 chars (`server.mjs:3008`), so the **storage and the API already carry a display name
distinct from the id — only the write path for changing it is missing.**

### 2c. Creation is id-only

`apps/web/src/components/sidebar/ProjectSwitcher.tsx:8`:

```ts
const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
```

`:67-85` validates the single text field against it and calls `create(id)`;
`apps/web/src/lib/projects.ts:82-83` defaults `name = projectId`; `apiClient.ts:1240-1246`
posts `{ id, name }` with both equal. The field's label and placeholder say 「新项目名」
(`:143-144`) and the error says 「项目名只能用字母、数字、连字符和下划线」 (`:70`) — so the
product asks for a *name* and then refuses every Chinese character. A researcher cannot name a
project 「阿司匹林一级预防」.

### 2d. What a project actually scopes (verified)

| Thing | Where | Keyed by |
|---|---|---|
| runtime container | `apps/server/src/runtimeManager.mjs:2928` `const key = this.key(project)`, `:2931` `this.runtimes.get(key)` | user + project |
| workspace directory | `apps/server/src/store.mjs:613-635` (`activeWorkspace` → `workspaceDir`), `:1011-1025` (Postgres `active_workspace`) | project row |
| run ledger | `apps/server/src/agentRuns.mjs` — every read is `readLedgerText(project, …)`; `this.projects.set(\`${project.userId}:${project.id}\`, …)` (`:3198`) | user + project |
| files / artifacts | all artifact reads resolve under `project.workspaceDir` (e.g. `agentRuns.mjs:2609`) | project |
| research memory | `apps/server/src/researchMemory.mjs:952` — `record.scope === "project" && record.scopeId === projectId`; `deleteProjectMemory` `:1020` | project, **for project-scoped records only** |
| inbox | `notificationPersistence.mjs:26` composite FK, cascade on project delete | project (nullable) |
| capsules, plugins, autopilot agendas, sources | per-project rows in `evimed_product` | project |

So a project is a **container boundary, a filesystem boundary, a ledger boundary and a partial
memory boundary** — the heaviest concept in the product. It is also **capped**: `server.mjs:3014`
refuses creation past `config.maxProjectsPerUser`, and the runtime slot cap on the f000
deployment is 1, so switching projects stops a container and starts another.

### 2e. The concept is explained nowhere

Grep of `apps/web/src` for any prose defining a project finds exactly one sentence, and it is a
code comment, not UI: `ProjectSwitcher.tsx:15-16` ("It sits under the wordmark because it scopes
everything below it"). The switcher itself shows a folder icon, a name and a chevron. There is
no description, no help text, no empty-state explanation, no per-project metadata (created,
runs, size) anywhere in the switcher or on the account page's projects card.

### 2f. The proposed model

1. **Display name and id are separate concepts, and only the name is a UI concept.**
   The id stays `[a-z0-9-]`, is derived, and is shown only in 「技术标识」-style disclosures —
   the same rule `RunsPage.tsx:612-622` already applies to run/session/model ids.
2. **Creation asks for a name, in any language.** One field, placeholder 「例如：阿司匹林一级预防」,
   `maxLength=64`. The id is auto-slugged in the client: ASCII-fold, lowercase, non-matching
   runs → `-`, collapse, trim, cap at 40; if the slug is empty (all-CJK name, the common case)
   or already taken, append a 6-char random suffix — `proj-8f2a1c`. Show the slug under the
   field as 「标识：proj-8f2a1c」 so it is never a surprise. `createWebProject(id, name)`
   already takes both.
3. **Rename exists.** `PATCH /api/projects/:id` accepting `{ name }` (≤128, the cap already
   validated at `server.mjs:3008`) → `UPDATE …projects SET name = $3, updated_at = now()`. In the
   switcher, a pencil on hover per row and a rename entry in the account page's projects card.
   No id rename — the id is a path segment under `projects/`, and renaming it would move a
   container's workspace.
4. **First-run naming.** The default project is created eagerly by `ensureDefaultProject`
   (`store.mjs:1033-1040`) before anyone has typed anything. Two options, in order of preference:
   (a) name it from the first task — when a run in project `default` records a `question`, and
   the project still carries the seeded name, set the name to the question's first 24 chars;
   (b) failing that, seed it in Chinese.
5. **What to call the default one.** `'Default Project'` → **「我的研究」**. It reads as a place
   the researcher owns rather than a system slot, it is what the sidebar's own vocabulary
   (「新任务」/「运行记录」/「知识库」) leads with, and it does not lie about being a template.
   The literal is in two places (`store.mjs:571`, `:1035`) — both must change, plus a one-time
   migration `UPDATE …projects SET name = '我的研究' WHERE id = 'default' AND name = 'Default Project'`,
   which is safe because a user who renamed it no longer matches.
6. **Explain it once, where the decision is made.** Under the switcher's list, one muted line:
   「一个项目= 一个独立的工作区、运行记录与记忆范围；切换项目会重启研究运行时。」 That sentence is
   true of every row in the table in 2d and is the thing nobody has been told.

---

## 3. Recent-task rows all titled 「临床证据深度分析」

### 3a. Root cause

`apps/web/src/lib/runPresentation.ts:39-47`:

```ts
export function runTitle(run: WebAgentRun): string {
  const question = run.question?.trim();
  if (question) return question;
  const agent = run.effectiveAgentId ?? run.agentId;
  const named = runAgentName(agent);
  if (named) return named;
  if (agent) return agent;
  return "未记录题面的运行";
}
```

The capability name wins **because `run.question` is null on almost every row**. Measured on the
walk's own capture (`docs/ui-ux-audit/2026-09-18-walk/runs.json`, 25-row sample of 25 runs):
**23 of 25 have an empty prompt**; only the two runs started after the adoption path landed
carry one. `runAgentName` → `capabilityTitle('clinical-evidence-synthesis')` → 「临床证据深度分析」
for every one of them, which is exactly the eleven identical rows in
`docs/ui-ux-audit/2026-09-18-walk/01-runs.png`.

Why `question` is null: it is only written on three paths —
`agentRuns.mjs:164` (`questionPreview(input.question)`, dispatch payload),
`:4845` (`routed.question`), and `:5052` (`questionPreview(question)` where `question` is the
first user message's text, in `adoptRuntimeTurns`). Rows created before those paths existed have
no column value, and nothing backfills them.

There is a **second, latent** cause that will reproduce the same symptom on new rows: a run
started from a capability card carries the templated brief as its question.
`packages/domain/src/capabilityDisplay.mjs:166-168`:

```js
export function capabilityBrief(title, prompt) {
  return `请以「${title}」能力完成以下任务：\n${prompt}`
}
```

Every capability-card run of the same capability therefore begins with the identical 20-odd
characters, and `questionPreview` (`agentRuns.mjs:127-132`) collapses whitespace so the newline
disappears. In a truncated one-line sidebar row (`Sidebar.tsx:251`, `flex-1 truncate`) those
rows are again indistinguishable.

### 3b. What data exists to build a good title

From `WebAgentRun` (`apps/web/src/lib/apiClient.ts`, and the list route
`server.mjs:2622` → `agentRuns.withPlanProgress(project, await agentRuns.recover(project))`):

| Field | Where it comes from | Usable as a title? |
|---|---|---|
| `question` | first user message, ≤160 chars (`agentRuns.mjs:125-132`) | yes, when present |
| `planItems[].title` | the run's own plan (`agentRuns.mjs:3178-3183`) | yes — but **only populated while `status === "running"`, and for at most 3 runs per request** (`:3168-3170`) |
| `artifacts[]` | delivered file paths | weak — filenames are `clinical-evidence-report.md`-shaped |
| `effectiveAgentId` / `agentId` | router | the current fallback |
| `sessionId`, `model`, `mode`, `startedAt`, `durationMs` | ledger | not titles |
| kernel session title | **not plumbed.** `sessionListItems` (`apps/server/src/dshRuntimeAdapter.mjs:173-176`) returns raw kernel rows and no caller reads a `title`; `packages/harness-port/seam-manifest.json` has no `title` entry. Whether 0.1.5-rc.2's `session/list` carries one is **not determined** from this repo. | not today |

So the honest answer: **the only real title source is `question`, and it is missing.** The fix
is therefore mostly on the write side.

### 3c. The fix

1. **Backfill.** For a run whose `question` is null and whose session is addressable, read the
   first user message from the session history (`readSessionHistory`, already used at
   `agentRuns.mjs:3219`) once, on first list, and append a ledger event carrying
   `questionPreview(text)`. Idempotent, and the ledger is append-only, which is what it is for.
2. **Strip the brief preamble at the point the title is made, not the point the brief is made.**
   The brief must stay byte-identical (the gate reads it as a high-confidence expectation,
   `CapabilitiesPage.tsx:20-26`), so `runTitle` should drop a leading
   `请以「…」能力完成以下任务：` before using the question:
   ```ts
   const question = run.question?.replace(/^请以「[^」]{1,40}」能力完成以下任务[:：]\s*/, "").trim();
   ```
   with the capability name then carried by the tag that already exists beside it
   (`capabilityLabel`, `RunsPage.tsx:519-525`). One regex over a closed, product-owned template
   string — not an open-vocabulary prose pattern, so principle 5 is not in play.
3. **Second line, not a longer first line.** In the sidebar, a row is one truncated line.
   Give it a second muted line carrying date + outcome
   (`WEB_RUN_STATUS_LABEL` + `relativeTs`), which is what actually distinguishes twelve runs of
   the same capability. Same in the ledger row, where there is already a duration and a relative
   timestamp but they are pushed to the right edge and clipped at narrow widths.
4. **Say the capability once.** `Sidebar.tsx:251` shows only `runTitle`, so when the title *is*
   the capability name the row says nothing else. `RunsPage.tsx:581-583` shows the capability tag
   *and* the same name as the title — duplicated. When `runTitle(run) === capabilityLabel(run)`,
   suppress the tag.

### 3d. What the dot colours mean

`apps/web/src/lib/runPresentation.ts:20-26`:

```ts
if (run.status === "running") return "animate-pulse bg-accent";     // rust, pulsing
if (run.phase === "degraded" || run.verification != null) return "bg-warn";   // ochre
if (run.status === "succeeded") return "bg-ok";                     // green
if (run.status === "failed") return "bg-error";                     // red
return "bg-muted";                                                   // grey = canceled/unknown
```

Defects:

- **The legend exists nowhere.** Only the running dot has a tooltip (`Sidebar.tsx:249`,
  `title={run.status === "running" ? "正在运行" : undefined}`); the other four are unlabelled
  colour, which is also the a11y failure — colour is the sole carrier of the outcome.
- **The ledger and the sidebar disagree.** `RunsPage.tsx:563-569` uses a *different* rule —
  `failed ? bg-error : succeeded ? bg-ok : bg-muted` — with **no amber branch at all**. So the
  same run is amber in the sidebar and grey/green in the ledger. Fix: `RunsPage` must call
  `runDotClass(run)`; it already imports from the same module.
- `bg-muted` on `bg-surface` is 5.37:1 as a text colour but as a 6 px dot it is a shape, not
  text; the four non-running states need `title=` + `aria-label` regardless.

---

## 4. The 「运行记录」 page

Files: `apps/web/src/app/routes/RunsPage.tsx` (1 135 lines),
`apps/web/src/lib/runPresentation.ts`, `components/inspector/FilePreviewInspector.tsx`,
`components/markdown-viewer/*`.

### 4a. Information architecture — what it is

One scroll, one column, `max-w-3xl` (`:465`). Header (`:466`) → sticky filter bar
(`:469-478`: search + status facet chips + `任意时间/24h/7d/30d`) → day-grouped rows (`:488-501`).
A row is a button that expands in place (`:553-590`); the newest row is auto-expanded on load
(`:302`) and `?run=` deep-links one (`:283-285`, `:458-460`).

An open row holds, in order (`:592-780`): capability + phase chips → 「技术标识（供排查使用）」
disclosure → actions (复查与复现 / 打开对话 / 耗时 / tool-call count) → `PlanSteps` (running only)
→ `RunVerdict` (non-delivering only) → the verification box with grouped notices → 「个性化依据」
disclosure → 产物 list with per-file 采纳/我改过 → 未通过核验的文件.

**Defect (P1): the open row is a ten-section stack with no hierarchy.** Every section is the
same `text-caption` size and the same muted uppercase label; the two sections a researcher
actually wants — the files and the verification verdict — are fifth and seventh. On the walk's
screenshot (`01-runs.png`) the first thing under an open row is 「技术标识（供排查使用）」, i.e.
the disclosure whose whole purpose is to *not* be first. Reorder: 产物 → 核验 → 交付进度 →
个性化依据 → 技术标识, and give 产物 a real heading rung rather than `text-caption uppercase`.

### 4b. States

| State | Present? | path:line |
|---|---|---|
| loading | yes, skeleton | `:481` `<RunsSkeleton />` |
| empty (nothing yet) | yes | `:485`, `:248-260` |
| empty (filtered) | yes | `:246` |
| error, with retry, keeping stale rows | yes | `:483`, `:228-242` |
| success | yes | — |

This is the one page in the shell where the four-state discipline is complete. The stale-refresh
wording at `:231` (「刷新运行记录失败，下面显示的是上一次读到的内容。」) is a model for the rest.

### 4c. Density

`max-w-3xl` = 768 px on a 1440 px viewport. A collapsed row packs six things into one line
(`:553-590`): chevron, dot, title (`flex-1 truncate`), capability tag, duration, relative time.
At 768 px with a 20-character Chinese question the title truncates while a 12-character
capability tag keeps its full width (`shrink-0`, `:581`). **Defect (P2):** the tag should
truncate before the title does, or move to the second line proposed in 3c.

### 4d. How a delivered report is opened, read and exported

- **Opened**: `ArtifactRow` (`:979-1013`) gives each file two controls — the row itself
  downloads (`:988-989`, `downloadArtifact(path, "workspace")`), and a separate 「预览」 button
  (`:1002-1009`) opens `RunFilePreview`, a right-side drawer (`:910-938`) rendering
  `FilePreviewInspector` lazily (`:900`).
- **Read**: inside the drawer, via `components/markdown-viewer/MarkdownViewer.tsx` and
  `ClaimCitation.tsx` (the 「依据」 popover). The drawer is `max-w-content-wide` (1024 px)
  anchored right, `role="dialog" aria-modal="true"` (`:924-925`), Escape-closable (`:911-915`),
  backdrop-click-closable (`:921`).
- **Exported**: download only. There is no print stylesheet, no 「导出 PDF/Word」, no copy-as-
  markdown. For a product whose deliverable is a clinical report this is a gap
  (**P1**) — the Office skills exist in the runtime image, but the reader has no one-click path.

**Defect (P1):** the drawer is the *only* way to read a report, and it is 1 024 px wide over a
dimmed page. A 62 KB evidence report with a matrix is a full-page document. Give the preview a
maximise control, or a `/app/runs/:id/files/:path` route that renders the same viewer full-width.

### 4e. How claim ✓/⚠ and `SAFETY — ` / `MUST FIX — ` are presented

`summarizeQualityNotices` (`runPresentation.ts:253-282`) splits on the two prefixes, strips them
(`:266`), maps the remainder to one of eleven Chinese group labels via `NOTICE_GROUPS`
(`:213-225`), and sorts safety → must-fix → advisory (`:273-276`).

`RunsPage.tsx:656-715` renders that as a box with a header line
(`「已交付，但未完成核验」` + 「临床安全 N 项 · 未通过核验 N 项 · 提示 N 项」) and a grouped list;
safety groups get a solid `bg-error text-error-fg` pill, must-fix a `bg-error/10 text-error`
pill (`:694-699`).

Defects:

- **P0 — the group fallback is 「其他核验提示」 and it is where most notices land.** Eleven regexes
  match eleven specific English sentence shapes (`runPresentation.ts:213-225`); anything else —
  including every new check — falls to 「其他核验提示」 and then renders **the raw English sentence
  verbatim** at `:705-708`. The screenshot `01-runs.png` shows exactly this. The comment at
  `:210-212` already names the correct fix ("the real fix is the gate emitting a code plus
  parameters instead of an English sentence") and it has not been done. **Do it**: `GateIssue`
  already has `{code, message, severity, path?, line?}` (`agentRuns.mjs:2781-2784` documents it)
  — carry `code` through `qualityNotices` instead of a flattened string, and key the Chinese
  label off the code.
- **P1 — advisory notices are shown with no visual weight difference from must-fix beyond the
  missing pill.** Same size, same colour, same bullet (`:703-709`). After the 2026-09-17 ruling
  most findings are advice; a reader cannot tell at a glance which three of twenty matter.
- **P1 — the ✓/⚠ per-claim marks are only inside the report viewer.** The row's prose points at
  them (`:680`: 「打开报告，句末的「依据」逐条标出…」) but the row itself never shows a count of
  verified vs unverified claims, although `claimVerification` exists in the domain. One line —
  「72 条结论，68 条引文已核对，4 条未核对」 — would be the single most useful sentence on the row.

### 4f. What a running run shows, and whether it is live

**It is not live.** Nothing in `apps/web/src` subscribes to `GET /api/runs/:id/events`:

```
$ grep -rn "EventSource\|/runs/.*events" apps/web/src --include=*.ts --include=*.tsx
(only /api/feedback/events — a POST — and unrelated matches)
```

The server route exists (`apps/server/src/server.mjs:3322-3326`, normalised at `:426`) and
`agentRuns.mjs:2756-2840` builds `deliverable/update` frames for it, with a comment
(`:2760-2766`) saying the browser "has had the listener … since then too" — **that listener does
not exist in this codebase.** The only consumers are the ledger poll
(`RunsPage.tsx:320-335`, every 20 s, visibility-gated) and the sidebar poll
(`Sidebar.tsx:108`, every 20 s). `evidence/update` and `budget/update` have **no** frontend
consumer either.

So a running run shows: a pulsing dot, a phase chip (`:596-600`), a tool-call count and
「最近进展 N 分钟前」 (`:632-639`), and `PlanSteps` (`:642`). All of it is up to 20 s stale, and the
「最近进展」 line is derived from `run.lastProgressAt`, which the monitor writes.

### 4g. Why 「交付进度 0/3 · 待开始」 stayed stale — root cause, traced

The page's reducer is not the problem: `PlanSteps` (`:951-977`) renders exactly what the server
sent, and `done` is `items.filter(i => i.status === "accepted").length` (`:959`).

The server sent `planned` for all three items. The chain:

1. `server.mjs:2622` → `agentRuns.withPlanProgress(project, runs)`.
2. `agentRuns.mjs:3167-3186` → `readRunStateProjection(project, project.workspaceDir, run)`.
3. `readRunStateProjection` (`:2642-2669`) — for a run with `nativeTurn` set it reads the
   **shared** `workspaceLayout.runStateFile` (`:2645`) and then hands it to
   `scopeNativeProjection(projection, run)` (`:2665`).
4. `scopeNativeProjection` (`:883-907`) **throws away the projection's own `status` field** and
   recomputes it from the parent turn's witnessed tool calls (`:895-900`):

```js
return { ...raw,
  status: submission?.accepted ? "accepted"
        : submission?.rejected ? "submitted"
        : proof.delegates.includes(definition.id) ? "delegated"
        : "planned",
  attempts: submission?.attempts ?? 0 };
```

5. `proof` is `run.nativeWorkflow`, built by `nativeWorkflowEvidence(run, history)`
   (`:823-873`) over **the parent session's own messages only**, and it counts a tool call only
   when it is finished — `:830`:

```js
if (part.type !== "tool" || part.state?.status !== "completed") continue;
```

`evimed_delegate` does not complete until its child session finishes. In the observed run the
first child ran **24 m 52 s** (F4). For all of that time the parent's two `evimed_delegate`
parts were `status: "running"`, so `delegates` was empty, so every item fell to the `"planned"`
branch → **「待开始 ×3」, 「交付进度 0/3」**, for 25 minutes, while the child's own
`.evimed-run/state.json` said item 1 was `rejected, attempts 2`.

`attempts` has the same shape of bug: `submission?.attempts ?? 0` (`:899`) can only ever see
submissions the *parent* made, and a delegated deliverable is submitted by the child. So
`PlanSteps`'s 「第 N 次提交」 suffix (`RunsPage.tsx:970`) is unreachable for delegated work.

**Fix (server, `agentRuns.mjs:895-900`).** The proof exists to stop a run claiming credit it
cannot prove — that justification covers `accepted`, not the progress states. Three changes:

- a plan item whose id appears in `projection.subagents` with a `running` status is
  **`delegated`**, regardless of whether the parent's `evimed_delegate` part has completed:
  `scopeNativeProjection` already filters `projection.subagents` at `:903-904` and discards the
  result for status purposes;
- a plan item whose raw projection status is `submitted`/`rejected` and whose id is in
  `subagents` takes the raw status — those are the child's honest submission states and no
  acceptance is being claimed;
- `attempts` takes `max(submission?.attempts ?? 0, raw.attempts ?? 0)`.

`accepted` must keep requiring a witnessed acceptance or a receipt entry — that is the one state
the proof exists to protect.

**Fix (adjacent, same cause).** The stall notice at `agentRuns.mjs:4719`:

> 「这次运行已有约 N 分钟没有可观测的进展（没有新消息、没有新工具调用、工作区也没有变化）。」

`recordProgress` (`:4539`) resets the counter on root-session history or authenticated kernel
activity, neither of which a child session produces, so a delegated run is declared stalled while
a child writes files every minute. And the parenthetical **claims the workspace did not change,
which the monitor never checks** — the sentence asserts a fact it did not measure. Either check
the workspace mtime (cheap: `stat` the deliverables dir) or delete that clause.

**Fix (client).** Subscribe to `GET /api/runs/:id/events` for the expanded row: the frames exist
(`deliverableFrames`, `agentRuns.mjs:2792-2840`), carry per-item `status`, `issues` and
`childSessionId`, and would make the step list correct within a second instead of within 20 s
and only for three runs per request.

### 4h. Other concrete defects on this page

- **P1** `:642` — `PlanSteps` renders only while `run.status === "running"`, and
  `withPlanProgress` only fetches then (`:3170`). A finished run's plan — which item was
  rejected, how many attempts — is unreachable afterwards. That is the record a researcher wants
  *after* the run, not during it.
- **P1** `:3168` — `let budget = 3`. The fourth concurrent running run silently has no step
  list, and nothing says so.
- **P2** `:302` — `setExpanded(current => current ?? newestRun(value)?.id ?? null)` auto-expands
  the newest run on every first load, so the page opens with a ten-section stack already unfolded.
- **P2** `:819-895` `DeliverableFeedback` — 「采纳」/「我改过」 are posted and never read back
  (`:815-817` admits it), so a reload shows both buttons again on a file already adopted. The
  ledger does record it; the row just does not ask.
- **P2** `:1015-1022` `Chip` uses `font-mono` for Chinese phase labels
  (「已交付，待人工复核」) — JetBrains Mono has no CJK coverage, so those glyphs fall through the
  stack to whatever the OS provides, at a different width than everything around them.
- **P2** `:254-256` — the empty state says 「当 EviMed 运行代码时（例如 `python train.py`）」.
  This product is an evidence workbench; `python train.py` is left over from an ML tool.
- **P2** `:1076-1079` `dayLabel` uses `toLocaleDateString("zh-CN", …)` while `formatDateTime`
  (`lib/format.ts`) is the project's own formatter — two date vocabularies on one page.
- **P2** `:164-178` — the recency switch renders the literal strings `24h / 7d / 30d` with
  `capitalize`, the only Latin-with-capitalize control in a Chinese UI. 「近 24 小时 / 近 7 天 /
  近 30 天」.

---

## 5. The capability pill row above the composer

### 5a. How it renders

`packages/harness-port/src/runtimeUiShell.mjs:176-193` — `CapabilityDock`, a
`React.createElement` tree built without JSX because the socket build emits `apply.toString()`
and the module may not close over an import (`:46-49`):

```js
const CapabilityDock = () => h('details', { style: { width: '100%', margin: '0 0 6px' } },
  h('summary', { style: { cursor:'pointer', fontSize:'12px', opacity:0.6, listStyle:'none', padding:'2px 0' } },
    `科研能力 · ${capabilities.length} 项`),
  h('div', { style: { display:'flex', flexWrap:'wrap', gap:'6px', padding:'6px 0 2px' } },
    capabilities.map(capability => h('button', {
      key: capability.id, type: 'button',
      title: `${capability.category} · ${capability.title}`,
      onClick: () => { try { target.__EVIMED_SHELL__?.navigate?.('new-task', capability.brief); } catch {} },
      style: { padding:'4px 10px', borderRadius:'999px', border:'1px solid rgba(127,127,127,0.28)',
               background:'transparent', color:'inherit', cursor:'pointer', font:'inherit', fontSize:'12px' },
    }, capability.title))));
```

It is registered into the kernel's `conversation.input.dock` slot (`:239`), not the hero's
`conversation.hero.agentPreset` — the comment at `:157-166` records why: `ui-agent-preset` is one
of the disabled panels, a disabled row declares no slot, so occupying it registered nothing and
rendered nothing, silently.

The data comes from the frame's bootstrap object, `frame.capabilities`, validated at
`:116-120` (id/title/category/brief all strings, brief ≤100 000, `.slice(0, 24)`). The server
side is `heroCapabilities()` (`apps/server/src/runtimeUiServer.mjs:232-252`): the agent registry
filtered to ids that exist in `CAPABILITY_DISPLAY`, sorted by `category` then `title` with
`localeCompare(…, "zh")`, each carrying
`brief: capabilityBrief(display.title, display.starterPrompts[0] ?? "")`.

### 5b. Defects in the dock

- **P1 — it is collapsed by default and its summary is 60 % opaque 12 px text.**
  `<details>` with no `open` attribute (`:177`) plus `opacity: 0.6` (`:180`). On a page whose
  whole job is to tell a researcher what the platform can do, the catalogue is a grey line.
  It is also the *only* thing in the composition telling a first-time user the fifteen
  capabilities exist, now that 「科研能力」 is one row down the sidebar.
- **P1 — clicking a pill mid-conversation abandons the conversation.** The click posts
  `shell-navigate` with `destination: 'new-task'` (`runtimeUiBridge.mjs:196-199`), the shell maps
  that to `/app/chat` with a **fresh `create` intent** (`RuntimeUiFrame.tsx:269-281`), and the
  bridge creates a new session. There is no "insert this brief into the composer I am already
  looking at" path, even though the dock sits **inside** that composer and `ctx` is right there.
  The comment at `:171-174` justifies routing through the shell because it "also works from the
  hero" — true, but the hero case is `create` and the in-session case should be a draft
  insertion. Cheapest fix: if the kernel already has a current session and the composer is empty,
  set the draft locally; otherwise navigate.
- **P2 — inline styles, none of them theme-aware.** `rgba(127,127,127,0.28)` is a fixed grey
  border and `color: 'inherit'` inherits the kernel's own text colour; the pills therefore match
  neither the shell's `--border`/`--accent` nor the kernel's own token set
  (`--dsw-*`, 358 variables, captured in `docs/ui-ux-audit/2026-09-18-walk/chat.json`). Read the
  kernel's own `--dsw-` variables instead — they are on the document and are the only tokens
  valid inside that frame.
- **P2 — a pill carries only the title.** Duration, category and what it produces are in the
  `title` attribute (`:187`), which is a hover tooltip: unreachable on touch, and not announced
  by most screen readers. Fifteen pills of 4–8 Chinese characters wrap to three rows with no
  grouping, although the server already sorted them by category (`runtimeUiServer.mjs:246`).
- **P2 — the catalogue is memoised for the process lifetime.** `heroCapabilities()` caches into
  the closure variable `capabilityCards` (`runtimeUiServer.mjs:233`) and nothing invalidates it,
  so a capability added or hidden needs a control-plane restart to appear in the dock. The
  「科研能力」 page re-fetches per visit and would disagree until then.

### 5c. `CapabilitiesPage.tsx` and the click→task path

`apps/web/src/app/routes/CapabilitiesPage.tsx:70-76`:

```ts
const open = useCallback((agent: WebResearchAgent) => {
  const ui = researchAgentUi(agent);
  navigate("/app/chat", { state: { runtimeUiIntent:
    newRuntimeUiIntent(capabilityBrief(ui.title, ui.starterPrompts[0] ?? "")) } });
}, [navigate]);
```

Path: `newRuntimeUiIntent(draft)` (`lib/runtimeUiNavigation.ts:12-17`, mints `kind:"create"` +
`requestId` + `sessionId`) → router state → `SessionRoute` sees `wantsNewTask`
(`SessionRoute.tsx:37`) and skips the resume lookup → `RuntimeUiFrame` validates the intent
against the current project (`runtimeUiNavigation.ts:19-29`) → on `ready`, posts
`evimed.runtime-ui.navigate` with the draft (`RuntimeUiFrame.tsx:334-338`) → bridge creates the
session and calls `setDraft` → `ack` → shell replaces the URL with the real session id
(`:302-310`). The draft is never submitted — the researcher presses Send. That path is sound and
is the same one the dock uses.

Defects on the page itself:

- **P1 — only the first starter prompt is ever used.** `ui.starterPrompts[0] ?? ""`
  (`:73`) — the row displays `示例：{ui.starterPrompts[0]}` (`:204`) and the remaining prompts are
  fetched, mapped, made searchable (`:88-91`) and never shown. Every run of a capability
  therefore starts from the identical brief, which is also the latent cause in §3a. Render the
  starter prompts as separate, clickable lines.
- **P1 — there is no way to edit the brief before it is sent.** The card fills a composer in
  another origin's document; between the click and the composer there is a full page transition
  and a session creation. A researcher who wanted to adjust the question first cannot.
- **P2 — `text-muted/80` on the example line** (`:204`) measures **3.53:1** on `--surface`
  (computed below) — below WCAG AA for 12 px text, and it is the only line on the card that
  tells a reader what the capability actually does with their question.
- **P2 — the card grid is a 3-column `grid-cols-[3rem_minmax(0,1fr)_auto]`** (`:187`) with a
  `py-6` row; fifteen of them is a 2 000 px scroll. The page has a category `<select>` (`:133`)
  but no grouped view, so the sorted categories the server computes are invisible here.
- **P2 — the monogram.** `researchAgentUi` (`lib/researchAgentUi.ts:15-18`) falls back to
  `agent.title.slice(0, 2).toUpperCase()` when a capability is absent from `CAPABILITY_DISPLAY`.
  For a Chinese title that slices two Chinese characters into a 9×9 `font-mono` box (`:189`) —
  JetBrains Mono has no CJK glyphs. The walk saw `SA/BA/CS/CE`, i.e. the display table's own
  two-letter codes, so the fallback is currently unreached — but it is one missing catalogue row
  away.

---

## 6. Colour, tone, brand and typography

Moved to **Section 2** below, with the full token table and the computed contrast figures.

---

## 7. The credentials banner on every page

### 7a. What it is

`apps/web/src/components/settings/ConnectorPrompt.tsx`, mounted unconditionally in the shell at
`apps/web/src/app/layout/AppShell.tsx:114`. It renders when
`fetchWebConnectors()` returns anything with `needsAttention` (`:54-57`) and the current path is
in `BANNER_PATHS` (`:28-36`) — **seven of the eight workbench routes**; only `/app/chat` is
excluded, plus the connectors tab it points at (`:46-48`).

Dismissal is a single 100-year `localStorage` timestamp
(`CONNECTOR_PROMPT_SNOOZE_KEY`, `:37-40`, `:68-71`), written by all three controls
(去配置 / 稍后再说 / ×).

### 7b. Root cause of the complaint

The banner is not buggy — it is correctly scoped and permanently dismissible. The complaint is
about **what it says and who it says it to**:

1. **It is deployment state, shown to a clinician.** 「7 个数据源本部署没有配置凭据」 is a fact
   about the *deployment* (`c.needsAttention` is a server-side property of the connector
   catalogue), and on a hosted multi-tenant SaaS the person reading it usually cannot act on it.
   It is an operator notice rendered on the researcher's first screen.
2. **It fires on an empty account.** `fetchWebConnectors()` runs on mount with no condition
   beyond the snooze (`:50-64`), so it greets a brand-new account — before any run, before any
   source has been needed — with seven source names and a config link.
3. **It is an interstitial for a non-urgent, non-blocking condition.** Nothing is broken; those
   sources simply are not configured. Principle-wise this is a "notice first, block never"
   condition being given banner weight.
4. **It costs vertical space on every list page.** `mx-4 mt-3 … py-3` (`:77`) above the page's
   own header, pushing sticky filter bars and page titles down.

### 7c. Where it belongs

- **Default state: not a banner.** Move the persistent form to the account page's connectors tab
  (it is already there) and to a **count badge on the 「账户与设置」 sidebar row** — the same
  affordance the bell uses, which is what a standing, non-urgent, deployment-level condition
  deserves.
- **Show it inline at the moment it matters.** When a run's ledger carries an evidence-source
  error whose code maps to a missing credential (`recoverableEvidenceSourceErrorCodes`,
  `apps/server/src/agentRuns.mjs`), show the prompt **on that run's row**, naming the one source
  that was needed — not seven that were not.
- **If a first-login banner is kept at all**, gate it on the account having run something, cap
  it at the top three sources by what the capability catalogue actually uses, and keep the
  permanent dismissal that already exists.
- **Say what the reader loses.** The current second line is
  `pending.slice(0,3).map(c => \`${c.title}：${c.unlocks}\`).join(" ")` (`:86-89`) — three
  `title：unlocks` pairs run together with spaces and no separator, so at 12 px it reads as one
  sentence. If the banner survives, make it a list.

---

## 8. Session-open latency (10–11 s, F6)

### 8a. The sequence, in order, all serial

| # | Step | Code | Network? |
|---|---|---|---|
| 1 | route chunk for `SessionRoute` | `apps/web/src/app/router.tsx:19` (`lazy(() => import(…))`) | yes |
| 2 | `fetchWebMe()` to learn `uiOrigin` | `SessionRoute.tsx:71-79` | yes (cached ≤2 s, `apiClient.ts:1131`) |
| 2b | **only on `/app/chat`**: `listWebAgentRuns()` → `navigate` to the newest session → the whole route remounts | `SessionRoute.tsx:51-69` | yes, plus a remount |
| 3 | `POST /api/runtime-ui/frames` | `RuntimeUiFrame.tsx:149`, server `server.mjs:2473-2486` | yes |
| 4 | iframe document `GET /__evimed/f/<frameId>/` | `RuntimeUiFrame.tsx:382-387` → `runtimeUiServer.mjs` → `runtimeManager.proxy` → `runtimeManager.start(project)` (`runtimeManager.mjs:4461`) | yes; cold start if the container is stopped |
| 5 | the kernel client's JS/CSS bundles, one request each, **all proxied** | `runtimeManager.proxy`, `:4431-4610` | yes, many |
| 6 | the EviMed bootstrap module | `runtimeUiServer.mjs:331-336` | yes |
| 7 | kernel boots, opens `/api/remote.mux` (WebSocket upgrade through `proxyUpgrade`, `runtimeManager.mjs:5059`) | — | yes |
| 8 | `ctx.sessions.refresh()` **completes**, then `post('ready')` | `runtimeUiBridge.mjs:117-121` | yes (mux round trip) |
| 9 | shell posts the `navigate` intent (only now — the effect is gated on `ready`) | `RuntimeUiFrame.tsx:328-339` | — |
| 10 | bridge opens/creates the session, posts `ack`; `setNavigated(true)` clears the overlay | `runtimeUiBridge.mjs:95-99`, `RuntimeUiFrame.tsx:295-310`, overlay at `:379-381` | yes (mux round trips) |

Nothing overlaps: step 9 cannot start before step 8, step 8 cannot start before the bundle in
step 5 has executed, step 4 cannot start before step 3 returns a `frameUrl`.

### 8b. The two findings that explain most of the cost

**(i) The kernel client is served uncacheable, and its URL changes every mount.**

`apps/server/src/runtimeManager.mjs:356-363`:

```js
if (surface === "ui") {
  responseHeaders["content-security-policy"] = `frame-ancestors ${embedder}`;
  responseHeaders["x-content-type-options"] = "nosniff";
  responseHeaders["cache-control"] = "private, no-store";
  delete responseHeaders.etag;
  delete responseHeaders["last-modified"];
}
```

This applies to **every** `surface === "ui"` response — the HTML, every JS chunk, every CSS file,
every font. `no-store` with `etag` and `last-modified` deleted means no cache, no revalidation,
no 304. The bootstrap module sets the same header itself (`runtimeUiServer.mjs:334`).

Independently, the asset base path is `/__evimed/f/${frameId}/` (`runtimeUiFrames.mjs:94`) and
`frameId` is minted fresh on **every** `createWebRuntimeUiFrame` call — i.e. every mount of
`BoundRuntimeUiFrame` (`RuntimeUiFrame.tsx:149`), every project switch (`:83`, the `key`), every
retry (`:160`, the `attempt` dependency). So even if the headers allowed caching, every URL
would be a cache miss.

Each of those responses is also **buffered whole in the control plane** before a byte is written
(`readRuntimeResponseBody`, `runtimeManager.mjs:4553-4557`), because only `text/event-stream`
takes the streaming branch (`:4526`).

*Fix:* immutable, content-addressed assets are exactly what `Cache-Control: private, max-age=…,
immutable` is for. Split the rule: keep `no-store` for the document and for anything under
`/api/`, and serve static asset paths with `private, max-age=604800, immutable` plus the
upstream `etag`. Then stabilise the base path — use one per *project+session*, or move the frame
id out of the path into the cookie it already sets (`runtimeUiFrames.mjs:96` sets
`Path=${prefix}`, which is why it is in the path; a per-project prefix with the frame id in the
cookie value keeps the same scoping and makes the URLs stable).

**(ii) `/app/chat` costs one extra full round trip plus a remount.**

`SessionRoute.tsx:51-69` resolves "the most recent addressable session" by listing **all** runs
(`listWebAgentRuns()`), then `navigate(..., { replace: true })`, which changes the route and
remounts the frame. The whole of steps 3–10 then happens for the second time in that navigation.
Measured: 10.3 s for `/app/chat` vs 11.2 s for `/app/chat/:id` (F6) — the two are within noise of
each other only because the second already had a warm frame in the walk's ordering.

*Fix:* have `/api/me` carry `lastSessionId` (the control plane already reads the ledger on that
request path) so the route can redirect before it mounts anything, or drop the resume-by-default
behaviour and let 「新任务」 mean a new task and `/app/chat` mean the last one **without** a
list call.

**(iii) Minor, same family.** `RuntimeUiFrame.tsx:71-79` calls `fetchWebMe()` on every mount even
when `webRuntimeProfile().uiOrigin` is already known; it is deduplicated for 2 s
(`apiClient.ts:1130-1131`) but on a cold navigation it is a serial leg before the frame POST.

### 8c. What the waiting state should show

Today: one line of muted grey text, centred in an otherwise empty page —
「正在启动研究运行时…」 / 「正在打开研究任务…」 (`RuntimeUiFrame.tsx:379-381`) and
「正在打开最近的任务…」 (`SessionRoute.tsx:90`). For 10 s, on the product's main surface, that
reads as a hang.

Proposal, in order of value:

1. **Render the shell's own chrome immediately.** The conversation page is a composer at the
   bottom and a message column above it. Draw that skeleton — a disabled composer with the real
   placeholder text, and the capability dock, both of which the shell already has the data for
   (`heroCapabilities` is in the bootstrap, but the *shell* can fetch `/api/agents` too) — so the
   page looks like itself while the frame loads behind it. `opacity-0` the iframe until `ready`
   and cross-fade.
2. **Name the stage, and let it be ordinary.** Three states rather than one sentence:
   「正在准备研究运行时」 → 「正在载入研究界面」 → 「正在打开任务」, driven off the messages the
   bridge already posts (`connecting` / `ready` / `ack`). A named stage that advances does not
   read as a hang.
3. **Say something after 5 s, not only at 30 s.** The only escalation today is the 30-second
   timeout at `RuntimeUiFrame.tsx:224`. At ~5 s add a muted second line —
   「首次打开需要启动容器，通常 10 秒左右。」 — which is true and removes the ambiguity.
4. **Warm the frame from the sidebar.** `Sidebar.tsx` already polls the run list; a
   `POST /api/runtime-ui/frames` issued on hover/focus of a 「最近任务」 row, or on shell mount,
   moves step 3 and part of step 4 off the critical path. Cheap: the frame is a signed cookie and
   the runtime is already warm for any account with a running run.

---

# Section 2 — tokens, contrast, brand, typography

## 2.1 Every token in `apps/web/src/index.css`, with value and role

Light is `:root` / `[data-theme="light"]` (`index.css:13-49`); dark is `[data-theme="dark"]`
(`:51-77`). Tailwind maps each to a utility name in `apps/web/tailwind.config.js:7-22`.

| Token | Utility | Light | Dark | Role, as used |
|---|---|---|---|---|
| `--bg` | `bg-bg` | `#f7f5ef` | `#16151a` | the page canvas behind every route; the shell's outermost `div` (`AppShell.tsx:84`) |
| `--surface` | `bg-surface` | `#ffffff` | `#1e1d24` | cards, the sidebar column (`Sidebar.tsx:165`), inputs, popovers |
| `--surface-2` | `bg-surface-2` | `#f2efe7` | `#26252d` | hover fills, chips, active nav row, the connector banner |
| `--border` | `border-border` | `#e7e3da` | `#33313c` | every 1 px rule; also the scrollbar thumb (`index.css:105`, `:112`) |
| `--border-faint` | `border-faint` | `#efece5` | `#25242b` | the run row's left rail, inner separators |
| `--text` | `text-text` | `#2a2723` | `#ece9e2` | all primary copy |
| `--muted` | `text-muted` | `#6f6a61` | `#9a958c` | secondary copy, meta, timestamps, icons inside nav rows |
| `--accent` | `bg/text-accent` | `#b24f2a` | `#d0764f` | the brand action colour: primary buttons, the running dot, the bell badge, the focus ring (`index.css:123`), capability category labels |
| `--accent-fg` | `text-accent-fg` | `#ffffff` | `#16151a` | foreground on `--accent` fills |
| `--link` | `text-link` | `#2869d0` | `#7aa5f0` | inline links and the run row's 「复查与复现」/「打开对话」 actions |
| `--warn` | `text/bg-warn` | `#96620f` | `#d7a24a` | degraded phase, unverified files, `rejected` plan items |
| `--ok` | `text/bg-ok` | `#40784e` | `#6bb07d` | succeeded runs, accepted plan items, 「已处理」 |
| `--error` | `text/bg-error` | `#b44c41` | `#d47a70` | failures, MUST FIX pills, destructive confirm |
| `--error-fg` | `text-error-fg` | `#ffffff` | `#16151a` | foreground on `--error` fills |
| `--series-1…8` | (chart only) | `#2a78d6 #1baf7a #eda100 #008300 #4a3aa7 #e34948 #e87ba4 #eb6834` | `#3987e5 #199e70 #c98500 #008300 #9085e9 #e66767 #d55181 #d95926` | categorical chart hues, shared with `@ai4s/shared` and the matplotlib style (`index.css:36-38`) |
| `--chart-grid` | (chart) | `#e7e3da` | `#33313c` | chart gridlines |
| `--chart-axis` | (chart) | `#cbc6bb` | `#4a4753` | chart axis lines |

Non-colour tokens: type scale `caption 12/1.5 · ui-sm 13/1.5 · ui 13.5/1.55 · body 15/1.65 ·
title 20/1.3 · display 26/1.25` (`tailwind.config.js:38-45`); containers
`content-narrow 672 · content 760 · content-wide 1024 · content-full 1080` (`:49-54`);
radii `input 10px · card 14px` (`:55-58`); shadows `card` (static) / `pop` (overlays) (`:59-62`).

Two gaps in the token set, both of which force `eslint-disable`s or arbitrary values today:

- **No rung below 12 px.** The bell badge needs 11 px (§1b); `Sidebar.tsx:169-170` already
  carries an `eslint-disable` for the 17 px wordmark. A `badge: ["11px","1"]` rung and a
  `wordmark: ["17px","1"]` rung would retire both.
- **No `ring-offset-color`.** `Button.tsx:42` uses `focus-visible:ring-offset-1` with Tailwind's
  default offset colour `#fff`, so a focused ghost button on a dark surface draws a **white**
  halo. Add `--ring-offset` → `ringOffsetColor: { DEFAULT: "var(--bg)" }`.

## 2.2 Contrast (WCAG 2.1 relative luminance, computed with `node`)

### Light

| Foreground | on `--bg` #f7f5ef | on `--surface` #ffffff | on `--surface-2` #f2efe7 |
|---|---|---|---|
| `--text` #2a2723 | 13.63 | 14.86 | 12.93 |
| `--muted` #6f6a61 | **4.93** | 5.37 | **4.67** |
| `--accent` #b24f2a | **4.76** | 5.19 | **4.52** |
| `--link` #2869d0 | **4.79** | 5.22 | **4.54** |
| `--warn` #96620f | **4.76** | 5.18 | **4.51** |
| `--ok` #40784e | **4.80** | 5.23 | **4.55** |
| `--error` #b44c41 | **4.76** | 5.18 | **4.51** |

`--accent-fg` on `--accent`: **5.19**. `--error-fg` on `--error`: **5.18**.

### Dark

| Foreground | on `--bg` #16151a | on `--surface` #1e1d24 | on `--surface-2` #26252d |
|---|---|---|---|
| `--text` #ece9e2 | 14.98 | 13.79 | 12.51 |
| `--muted` #9a958c | 6.10 | 5.61 | 5.09 |
| `--accent` #d0764f | 5.52 | 5.08 | **4.61** |
| `--link` #7aa5f0 | 7.32 | 6.74 | 6.11 |
| `--warn` #d7a24a | 7.92 | 7.29 | 6.61 |
| `--ok` #6bb07d | 7.03 | 6.47 | 5.87 |
| `--error` #d47a70 | 5.90 | 5.43 | **4.92** |

`--accent-fg` on `--accent`: **5.52**. `--error-fg` on `--error`: **5.90**.

**Reading:** the base palette passes AA (4.5:1) everywhere, but the six semantic colours clear it
by **0.01–0.10 on `--surface-2`** — there is no headroom at all, and any future darkening of
`--surface-2` or lightening of a semantic hue breaks it silently. None of them reaches AAA (7:1);
none reaches AA at *large* text either way, which does not matter since they are used at 12–15 px.

### Alpha composites actually in use — three of them fail AA

| Usage | Where | Contrast | Verdict |
|---|---|---|---|
| `text-text/90` | `Sidebar.tsx:245` (recent-task rows), `FilesPage.tsx:201`, `:395` | 10.84 / surface | pass |
| `text-text/80` | `RunsPage.tsx:678`, `:685`, `MemoryPage.tsx:583` | 7.76 / surface | pass |
| `text-text/70` | `RunsPage.tsx:576`, `:705`, `:768`, `:795` | 5.55 / surface | pass |
| **`text-muted/80`** | **`CapabilitiesPage.tsx:204`** (the 「示例：」 line), `MemoryPage.tsx:303` (placeholder) | **3.53 / surface** | **fail AA** |
| **`text-muted/60`** | **`TableChart.tsx:102`** | **2.43 / surface** | **fail AA** |
| **`text-muted/50`** | **`FitsView.tsx:298`, `QCodeView.tsx:149`, `BandView.tsx:119`, `PhaseView.tsx:136`, `DosView.tsx:155`, `TableChart.tsx:194`** | **2.05 / surface** | **fail AA badly** |
| `opacity-70` on a count | `RunsPage.tsx:1132` (facet chip counts) | 2.92 / surface | fail AA |
| `--accent` on an `accent/10` fill | `RunsPage.tsx:1125` (active facet chip) | 4.51 light / **4.45 dark** | dark fails AA |

The `text-muted/50` uses are all chart hint lines (「悬停查看样本」 etc.) — decorative, but they
are the instruction telling a reader the chart is interactive. **Fix:** delete the alpha suffix
in all eight places; `--muted` is already the "quiet" token and it was deepened in P1-6 precisely
so that it would not need to be faded further.

`--border` at 1.17–1.42:1 against its backgrounds is intentional (a hairline is not text) but is
also below the 3:1 WCAG 1.4.11 threshold for a **non-text UI boundary**. The places where a
border is the only thing marking a control — the ghost `Button` (`Button.tsx`), `inputClasses`,
the facet chips (`RunsPage.tsx:1127`) — therefore have no perceivable boundary for a low-vision
reader. Fix narrowly: give interactive-control borders their own token at ≥3:1
(`--border-control`, e.g. `#c8c2b4` light / `#4d4a58` dark) and leave decorative rules alone.

## 2.3 Brand inconsistencies

Four different marks/colours claim to be EviMed:

| Artefact | Colour | Where |
|---|---|---|
| sidebar mark (SVG asset) | **`#2563EB`** (blue) | `apps/web/src/assets/evimed-mark.svg:2`, `:5`; rendered at `Sidebar.tsx:168` |
| browser favicon of the shell | **`#2563EB`** — the same asset | `apps/web/index.html:6` |
| the frame's React `Mark` | **`#2563EB`**, redrawn by hand | `packages/harness-port/src/runtimeUiShell.mjs:133`, `:135` |
| the frame's favicon | **`#1f6f5c`** (green), a *different glyph* (a plus in a rounded square) | `runtimeUiShell.mjs:61-66` (`EVIMED_FAVICON`) |
| the product's action colour | **`#B24F2A`** (rust/terracotta) | `--accent`, `index.css:28` |
| the kernel frame's own action colour | **`rgb(65,118,230)` = `#4176E6`** (blue send button), `rgb(237,243,254)` user bubble | measured, F7; the kernel's `--dsw-*` tokens, 358 of them (`docs/ui-ux-audit/2026-09-18-walk/chat.json`) |

So on the conversation page a researcher sees a **blue** mark in the left column, a **rust**
focus ring and badge in that same column, a **blue** send button in the frame beside it, and a
**green** favicon if they open the frame in its own tab. `#2563EB` is also the exact upstream
blue that item **P0-8** of `03-迭代任务清单.md` was raised to remove; it was removed from the
favicon and re-introduced as the mark.

**Fix, in order:**

1. Pick one brand hue. `--accent` `#B24F2A` is the one the whole shell is built on and it passes
   AA on white (5.19). Redraw `evimed-mark.svg` in it, and change the two `#2563EB` literals in
   `runtimeUiShell.mjs:133`/`:135` to match. The mark is four dots and three strokes; recolouring
   is a two-line change in each file.
2. One glyph. `EVIMED_FAVICON` (`runtimeUiShell.mjs:61-66`) draws a plus in a green square, which
   is not the mark at all. Inline the same four-dot geometry as a data URL, in the same hue.
3. `index.html:6` points the favicon at `/src/assets/evimed-mark.svg`; once (1) lands, the
   shell's tab icon, the frame's tab icon and the sidebar mark are one artefact in one colour.
4. **Tint the kernel frame.** The kernel exposes 358 `--dsw-*` custom properties on its own
   document. The shell plugin already injects a `<style>` element (`runtimeUiShell.mjs:287-336`);
   adding a `:root{--dsw-brand-…:…}` block there is the same mechanism and no more invasive than
   the three grid rules already in it. Which `--dsw-*` names carry the action colour is **not
   determined** from this repo — they are in the captured list and need one pass over
   `chat.json` to name.

## 2.4 Does the shell pass its theme into the iframe?

**No.** `grep -in 'theme|dark'` over `apps/web/src/app/routes/RuntimeUiFrame.tsx`,
`apps/server/src/runtimeUiDocument.mjs`, `apps/server/src/dshProfilePatch.mjs` and
`packages/harness-port/src/runtimeUiBridge.mjs` returns **zero** matches. The theme lives only in
`apps/web/src/app/providers/ThemeProvider.tsx:12-18`, which writes
`document.documentElement.dataset.theme` — on the *shell's* document.

Consequence: switching the product to dark (`ThemeSegmentedControl`, reachable only at
`SettingsPage.tsx:55`) turns the sidebar and all seven list pages dark and leaves the
conversation — the product's main surface, and the one that fills the viewport — **white**.
`prefers-color-scheme: dark` on the OS produces the same split via the `system` setting.

**Fix:** the bootstrap object already carries `version/frameId/projectId/prefix/shellOrigin/cwd/
capabilities` (`runtimeUiServer.mjs:333`). It cannot carry the theme, because the theme changes
after boot — so send it as a message instead: add `evimed.runtime-ui.theme` to the shell→frame
vocabulary (`RuntimeUiFrame.tsx` posts it on mount and on every `ThemeProvider` change), have the
bridge apply it, and have `runtimeUiShell.mjs` set the kernel's own colour-scheme attribute.
Which attribute that is, is **not determined** — the kernel's locale/slot APIs are documented in
the extracted client but the theme API is not covered by `seam-manifest.json`.

## 2.5 Typography

**Font stacks.** CJK-aware since 2026-09-16 (item V1):

- body (`index.css:97`): `Inter, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
  "Noto Sans CJK SC", "Source Han Sans SC", sans-serif`
- `font-sans` / `font-serif` / `font-mono` (`tailwind.config.js:27-31`): the same sans list,
  `'Source Serif 4', Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", SimSun,
  serif`, and `'JetBrains Mono', ui-monospace, monospace`.

Three defects:

1. **`font-mono` has no CJK fallback**, and it is applied to Chinese text in at least two places:
   `RunsPage.tsx:1017` (`Chip`, which renders 「已交付，待人工复核」) and
   `CapabilitiesPage.tsx:189` (the two-glyph monogram, which falls back to
   `agent.title.slice(0,2)` — two Chinese characters — for any capability missing from
   `CAPABILITY_DISPLAY`). Add the CJK sans faces to the end of the mono stack, or stop using
   `font-mono` for anything that can be Chinese.
2. **The frame uses a different stack entirely.** Captured `--dsw-font-family` is
   `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", …` at 16 px body / 14 px
   bubble, against the shell's Inter at 15 px body. Two type systems, side by side, on the page
   the product is for. Same fix mechanism as §2.3 item 4.
3. **Six of the seven `@fontsource` imports are unconditional** (`index.css:1-7`): Inter 400/500/
   600, Source Serif 4 400/600, JetBrains Mono 400/500 — seven font files downloaded on the login
   page, where only Inter 600 and Source Serif 4 600 are drawn (`LoginPage.tsx:99`, `:106`).

**Type scale.** Six rungs (`tailwind.config.js:38-45`), raised from 11/12.5 px to 12/13 px for
CJK stroke separability (item V2). Problems:

- **`caption` (12 px) is doing too many jobs.** It is the badge, the timestamp, the chip, the
  facet count — and also `EmptyState`'s *description* (`components/cards/EmptyState.tsx:28`),
  i.e. the sentence a first-time user most needs to read is set at the smallest rung in the
  system. And in `RunsPage` the **entire open row** is `text-caption` (`:593`), including the
  gate's findings.
- **`ui` (13.5 px) and `ui-sm` (13 px) are 0.5 px apart.** No reader distinguishes them; they are
  two rungs doing one job, and ESLint's ban on arbitrary sizes pushes authors to pick arbitrarily
  between them.
- **H1 rung is inconsistent across routes.** `text-display` (26 px) on
  `RunsPage.tsx:103`, `CapabilitiesPage.tsx:114`, `MemoryPage.tsx:268`, `SettingsPage.tsx:45`,
  `OpsPage.tsx:44`, `NotebooksPage.tsx:75`, `LoginPage.tsx:106`; `text-title` (20 px) on
  `InboxPage.tsx:92`, `SourcesPage.tsx:106`, `CapsulesPage.tsx:116`, `AutopilotPage.tsx:373`,
  and on every tabbed page via `WorkbenchTabs.tsx:60`. So 「运行记录」 is 26 px and 「收件箱」 is
  20 px for no reason a reader could infer. Pick one — `text-title` for all page H1s, since the
  tabbed pages cannot easily change — and reserve `display` for the login page and empty states,
  which is what the config comment says it is for (`tailwind.config.js:44`).
- **Section H2 is `font-serif text-body`** (15 px serif) in 14 places (`Card.tsx:39`,
  `AutopilotPage.tsx:390`, all six settings cards). A serif heading *smaller than* the surrounding
  body copy is not a hierarchy; it reads as an italic aside. Give H2 its own rung (17–18 px) or
  set it in `font-sans font-semibold text-ui`.
- **`uppercase` and wide `tracking` on Chinese.** `uppercase` is a no-op on CJK but the letter
  spacing is not: `MarkdownViewer.tsx:57` (`h4`, `uppercase tracking-[0.08em]`),
  `LoginPage.tsx:104` (`tracking-[0.18em]` on 「循证医学科研智能体」), `RunsPage.tsx:193`, `:658`,
  `:722`, `:743`, `:765`, `WebResourcesCard.tsx:147`. Spaced-out CJK is the Chinese analogue of
  the shouted-uppercase problem `CapabilitiesPage.tsx:100-101` already fixed once.

**The serif wordmark.** `Sidebar.tsx:169-171` sets 「EviMed」 in `font-serif text-[17px]
font-semibold leading-none tracking-tight` behind an `eslint-disable`. The 17 px is deliberate
(between `body` and `title`) and the comment explains it; the right resolution is a
`wordmark` rung, not a permanent disable.

---

# Section 3 — per-route findings

Severity: **P0** = wrong information, a dead end, or a destructive action with no guard;
**P1** = the page does not do its job well; **P2** = inconsistency, polish, debt.

## Cross-cutting (applies to most routes)

- **P0 — error is rendered as "empty" in eleven places.** A control plane that is down and an
  account that has nothing look identical, and readers believe the second.
  `FilesPage.tsx:71-78` (root listing failure sets `entries=[]` and returns without setting an
  error → 「这里还没有资料」 at `:184`); `NotebooksPage.tsx:28-32` (`refresh` has no `catch`, the
  rejection is unhandled and the page sits on 「暂无笔记本」 forever); `MemoryPage.tsx:421-439`
  (an `EmptyState` with `ServerCrash`, though it does carry a retry); `WebProjectsCard.tsx:153`;
  `WebAccountCard.tsx:122` (a network failure reads as 「当前没有登录账户。」); and the six
  operator cards (`WebAuditCard.tsx:17`+`:47`, `WebErrorsCard.tsx:18`+`:47`,
  `WebSecurityCard.tsx:18`+`:47`, `WebTasksCard.tsx:31`+`:72`, `WebReadinessCard.tsx:50`+`:94`,
  `WebResourcesCard.tsx:18`), all of which report a failure as a toast that vanishes and then
  render an empty list. `RunsPage.tsx:288-308` is the one page that does this correctly and is
  the model to copy.
- **P1 — nested `<main>` landmarks.** `AppShell.tsx:96` renders `<main>`, and so do
  `MemoryPage.tsx:260`, `CapsulesPage.tsx:112`, `MethodsPage.tsx:141`, `SourcesPage.tsx:101`,
  `AutopilotPage.tsx:368`, `InboxPage.tsx:90`. Inside `WorkbenchTabs` the inner `<main>` sits
  inside a `role="tabpanel"`.
- **P1 — `MemorySkeleton` is used as the universal skeleton.** `components/cards/Skeletons.tsx:58`
  is a two-column card grid with `mt-6` baked in, reused for a single-column card list
  (`SourcesPage.tsx:118`, `:230`, `:293`), a master/detail (`CapsulesPage.tsx:129`, `:158`), a
  methods list (`MethodsPage.tsx:184`), a briefing (`AutopilotPage.tsx:391`, `:428`), a panel
  body (`SourceUnderstandingPanel.tsx:116`) and the **inbox** (`InboxPage.tsx:98`). The file's
  own doc comment (`Skeletons.tsx:3-8`) says skeletons mirror what they stand in for; here they
  do not, so every one of those pages jumps on load — the defect skeletons exist to remove.
- **P2 — `LABEL[x] ?? x` renders a raw enum whenever the server adds a value.**
  `SourcesPage.tsx:298`, `:301`, `:331`, `:377`, `:384`, `:389`, `:390`; `CapsulesPage.tsx:180`;
  `MethodsPage.tsx:32`, `:206`, `:227`; `ClaimCitation.tsx:33`, `:94`; `WebReadinessCard.tsx:133`.
  The opposite bug also exists: `SourceUnderstandingPanel.tsx:119` has **no** fallback and renders
  `undefined`.
- **P2 — token drift outside the lint's reach.** The lint bans px font sizes, px radii, bare
  `shadow-sm/md/lg` and hex arbitraries (`apps/web/.eslintrc.cjs:7-32`) but not widths:
  `LoginPage.tsx:96` `max-w-[420px]` (vs `content-narrow`), `NotebooksPage.tsx:73` `max-w-3xl`,
  `RunsPage.tsx:465` `max-w-3xl`, `Toaster.tsx:53` `max-w-[70vw]`,
  `FilePreviewInspector.tsx:429` `shadow-[0_1px_4px_rgba(0,0,0,.25)]` + `:458`/`:468`/`:477`
  `min-h-[480px]` + `:500` `max-h-[80vh]`, `RightPane.tsx:108`/`:112`, `NotebooksPage.tsx:140`.
- **P2 — three date formatters bypass `lib/format.ts`.** `MemoryPage.tsx:44-49` (local
  `formatTime`), `CapsuleTransferPanel.tsx:63`, `:119` and `ProvenancePanel.tsx:223`
  (`toLocaleString()` with no locale). `RunsPage.tsx:1076-1087` adds a fourth vocabulary.

## `/app/chat` — `SessionRoute.tsx` + `RuntimeUiFrame.tsx`

- **P0** — 10–11 s to a usable composer, with a one-line grey loading state. Root cause and fix
  in §1.8.
- **P0** — the frame never receives the shell's theme (§2.4): dark mode splits the product in
  half at its main surface.
- **P1** `SessionRoute.tsx:51-69` — a plain visit to `/app/chat` lists every run to find a
  session to resume, then navigates and remounts the whole frame. One extra round trip plus a
  remount on the most-visited route.
- **P1** `RuntimeUiFrame.tsx:224` — the only escalation between "loading" and "failed" is a
  30-second timeout. Nothing is said at 5 s or 10 s.
- **P2** — the hero still reads 「从一个研究问题开始 / 选择一个工作区开始」 (captured in
  `2026-09-18-walk/chat.json`). The workspace row is hidden with CSS
  (`runtimeUiShell.mjs:302`, `[class$="_heroWorkspaceRow"]{display:none}`) but the string is
  still in the accessible tree and is read by assistive technology. Override the key in
  `EVIMED_DICTIONARIES` instead of hiding the element.
- **P2** — 「深度求索中...」 (F1) is the kernel's `chat.deepDiving`, overridable through
  `EVIMED_DICTIONARIES` (`runtimeUiShell.mjs:75-82`), which currently overrides only four
  `conversation.*` keys. It is the single most visible untranslated string in the product.
- **P2** `runtimeUiShell.mjs:330-333` — the frame's layout is held together by four
  `[class$="_hashedSuffix"]` CSS rules. Documented and deliberate, but it is the one place where
  an upstream rename produces a broken page rather than a failed test.

## `/app/runs` — `RunsPage.tsx`

Covered in full in §1.4. The graded list:

- **P0** `runPresentation.ts:213-225` + `RunsPage.tsx:705-708` — unmatched gate findings render
  as raw English validator sentences to a Chinese-reading clinician.
- **P0** `agentRuns.mjs:895-900` (server) — 「交付进度 0/3 · 待开始」 is wrong for the whole
  duration of delegated work.
- **P1** — nothing on this page is fed by `GET /api/runs/:id/events`; it polls at 20 s.
- **P1** `:642` + `agentRuns.mjs:3170` — the plan/step list exists only while running, and only
  for three runs per request (`let budget = 3`, `:3168`).
- **P1** `:563-569` — the row's dot uses its own rule instead of `runDotClass`, so the sidebar
  and the ledger disagree about the same run.
- **P1** — no export/print path for a delivered report; the drawer is the only reader.
- **P2** `:302` auto-expands the newest row; `:593` sets the entire open row at `text-caption`;
  `:612` puts 「技术标识」 first; `:819-895` feedback buttons never reflect a prior report;
  `:1017` `font-mono` on Chinese; `:254` 「python train.py」 in the empty state; `:164-178`
  `24h/7d/30d` with `capitalize`.

## `/app/files` — `KnowledgePage.tsx` (tabs: 文件 / 整理进度 / 计算笔记本)

- **P0** `FilesPage.tsx:71-78` — error-as-empty-state (above).
- **P0** `NotebooksPage.tsx:28-32` — unhandled rejection; the page can never leave its empty state
  after a failed load.
- **P1** `FilesPage.tsx:163-171` — the destination's primary action (upload) is an unlabelled
  28 px icon button at the end of a breadcrumb; the empty state (`:181-186`) describes uploading
  and offers no button, although `EmptyState` has an `action` slot (`EmptyState.tsx:21`).
  `WorkbenchTabs` also has an `actions` slot (`WorkbenchTabs.tsx:38`, `:63`) that
  `KnowledgePage.tsx` does not use.
- **P1** — the three tabs have three different page geometries: `FilesPage.tsx:120` is
  edge-to-edge split, `SourcesPage.tsx:101-102` is `px-5 py-6 max-w-content-wide`,
  `NotebooksPage.tsx:73` is `max-w-3xl px-8 py-6`. Switching tabs moves the content.
- **P1** `FilesPage.tsx:274`, `:342-344` — the session pane's **title is the raw project id**
  (`baseName("/workspace/" + getWebProjectId())`) with the container path in `title=`.
- **P1** `NotebooksPage.tsx:114` — the description 「单元格在笔记本目录的本地 Python 或 R 内核中
  执行」 describes the desktop build deleted 2026-09-04.
- **P2** `NotebooksPage.tsx:120-124` is a dead nested ternary (`hasWebApi ? hasWebApi ? A : B : C`)
  whose `B` branch is unreachable. `:89-108` is a hand-built `role="menu"` with no roving
  tabindex, no Escape, no focus return. `:140` `max-w-[40%]` shows the raw dated session folder.
- **P2** `FilesPage.tsx:136-208`, `:349-401` — ten hand-rolled `<button>`s where `buttonClasses()`
  exists; the breadcrumb is not a `<nav aria-label>`; the drop zone (`:120`) has no keyboard
  equivalent and its overlay (`:121-127`) is not announced.
- **P2** three names for one tab: the tab says 「整理进度」, the page says 「资料整理」
  (`SourcesPage.tsx:106`), the panel says 「资料整理台」 (`SourceUnderstandingPanel.tsx:140`).

### `SourcesPage.tsx` — the densest operator leak in the product

- **P1** `:95` + `:117` — a *mutation* failure (delete / retry / cancel / override) is written
  into the page-level `error` state whose retry button calls `load()`. It re-lists instead of
  retrying what failed, and the failed action's context is gone.
- **P1** `:384` 「理解遗漏审计：{audit.status}」 — a raw enum value in the sentence.
- **P1** `:171`, `:184`, `:199` — 「OpenList 网盘」, 「每个账号只能浏览自己的 /tenants 命名空间」,
  「此存储未提供 SHA-256，请改用平台上传」, 「网盘给出的 SHA-256 不合规」. Internal product name,
  a server path and a hash algorithm on a clinician's screen.
- **P1** `:242` — `{folder.payload.connector.id}` is rendered as a synced folder's **name**.
- **P1** `:391` 「解析处理成功 N% · 处理台账 N% · 失败单元 N/N」 — pipeline accounting.
- **P2** `:362` 「遗漏审计提示 · 仅供参考，不影响这份资料入库，也不需要你处理」 — a notice whose
  own text tells the reader to ignore it. Delete it or make it actionable.
- **P2** `:250`, `:401`, `:366` — English diagnostics and error codes in `title=` tooltips.
- **Good, and the model to copy:** `:77-87` — a 5 s poll gated on `document.hidden` and re-armed
  on `visibilitychange`.

## `/app/memory` — `MemoryHubPage.tsx` (tabs: 记忆 / 方法胶囊 / 学习方法)

- **P1** `MemoryHubPage.tsx:16` — a tab labelled 「记忆」 inside a destination titled 「记忆」
  (`:26`). `:20` 「学习方法」 is ambiguous (methods that were learned, or how to learn).
- **P1** `MemoryPage.tsx:128` + `:421-439` — one outage is reported twice: a toast *and* an
  `EmptyState`.
- **P1** `MemoryPage.tsx:563` 「置信度 N%」, `:571-573` 「疑似任务题面，非你的陈述」,
  `:254-256` 「科研记忆服务已连接」 — model scores, extractor jargon and service health on a
  clinician's page.
- **P2** `MemoryPage.tsx:298-304` a bare `<textarea>` in a file that imports and uses `Textarea`
  at `:386`/`:552`; `:651-662` and `:688-700` bare buttons.
- **P2** `CapsulesPage.tsx:119-120` — `<fieldset disabled>` around a `SegmentedControl` removes a
  roving-tabindex radiogroup from the tab order entirely during any mutation; `SegmentedControl`
  has no `disabled` prop, which is why.
- **P2** `CapsulesPage.tsx:73` — an entry-list failure sets `entries=[]` **and** the page error,
  so 「还没有条目」 renders under a red banner.
- **P2** `CapsulesPage.tsx:145-147` — 「主要胶囊 / 参考胶囊 / 合并参考」 under
  `aria-label="使用方式"` with no explanation of the difference; `:179` 「版本 {entry.revision}」
  is a database revision.
- **P2** `CapsuleTransferPanel.tsx:85` — `<span>✓ 工作方式（默认）</span>`: **a checked checkbox
  drawn as a text glyph**, in the same row as two real `<input type="checkbox">` (`:86`, `:87`).
  A screen reader announces the literal "✓". `:94` a bare file input styled as a text field.
  `:97` 「不超过 2 MiB 的 .evimedcap 文件」; `:105-106` 「作者身份未验证（外部自签名）」.
- **P2** `MethodsPage.tsx:42-52` puts raw YAML front-matter into the editor;
  `:166` `aria-label="方法内容（SKILL.md）"` reads an internal filename aloud; `:172` 「开头两行
  name 与 description 必填」. **`MethodsPage` is otherwise the only page in the sweep with all
  four states correct** (`:178-195`).

## `/app/autopilot` — `AutopilotPage.tsx`

- **P1** `:370-381` — opening 新建议程 injects a full `Card` form (`NewAgendaForm`, `:110`) into
  the page's `<header>` `flex-wrap justify-between` row.
- **P1** `:246-254` — the 「需要你决定」 inbox fetch has an **empty catch**: a failing inbox
  silently removes the section, and nothing says so.
- **P2** `:352-353` renders the raw IANA zone id (`Asia/Shanghai`); `:394` uses a raw server date
  string as a `Card` title; `:433` renders `{agenda.payload.pauseReason}` verbatim; `:164`,
  `:172` use 「门禁」 (internal vocabulary; the rest of the product says 「核验」).
- **P2** `:133` `grid gap-3 sm:grid-cols-4` — four currency fields in one row from 640 px up.
- **P2** `:124` six bare `<input type="checkbox">`.
- **Good:** `:357-367` a `ConfirmDialog` before spending, `:301-310` an undo toast on reject.

## `/app/capabilities` — `CapabilitiesPage.tsx`

Covered in §1.5c. Graded: **P1** only the first starter prompt is ever used (`:73`, `:204`);
**P1** no way to edit the brief before it is sent; **P2** `text-muted/80` at 3.53:1 (`:204`);
**P2** no category grouping although the server sorts by category; **P2** the `font-mono`
monogram fallback (`researchAgentUi.ts:17`).

## `/app/inbox` — `InboxPage.tsx`

- **P0** `:154` — 「标为已读」 renders only when `item.actions.length === 0`, and every
  run-finished item carries an `open` action (`server.mjs:1382`). **The commonest item in the
  inbox cannot be marked read from the UI.** Combined with the absent bulk endpoint (§1e), an
  inbox that has filled up cannot be cleared.
- **P1** `:128` — `item.body` is rendered verbatim, so the raw English validator text of §1f
  lands here unprocessed, while `summarizeQualityNotices` sits unused two files away.
- **P1** `:98` — `MemorySkeleton` (a two-column card grid) stands in for a one-column card list.
- **P2** `:12` — `TYPE_LABEL` covers exactly the three `NOTICE_TYPES` and would render
  `undefined` for a fourth; it has no `?? ` fallback (the opposite of the pattern everywhere
  else).
- **P2** `:92` header rung is `text-title` where five other pages use `text-display` (§2.5).
- **Good:** `:118-120`, `:133-151` — navigational actions outlive resolution and are `Link`s,
  not `<a href>`s.

## `/app/account` — `AccountPage.tsx` (tabs: 账户与额度 / 数据源 / 设置 / 运维台)

- **P0** `OpsPage.tsx:42-47` — the 「仅运维账号可见」 warning renders **only when
  `!embedded`**, and the page is only ever rendered embedded (`AccountPage.tsx:112`). So the
  operator console — a 24-row readiness board, a security-event ledger, and start/**stop**
  controls for the research runtime — appears as an ordinary tab with no framing.
- **P0** `WebResourcesCard.tsx:106-135` — 启动 / 重启 / **停止** the research runtime with **no
  confirmation dialog**, next to three other buttons. Stopping kills a running analysis.
  `ConfirmDialog` exists and is used elsewhere in the same tree.
- **P1** `AccountPage.tsx:35-45` — the identity fetch has **no `.catch`** (unhandled rejection)
  and no error state; on failure `:64` shows 「账号 正在读取…」 forever.
- **P1** `AccountPage.tsx:112` — `ops` is gated on `identity.operator`, presentation-only (which
  `OpsPage.tsx:19-22` documents as intentional). A non-operator who follows `/app/ops` lands on
  账户与额度 **silently**, with no explanation.
- **P1** `WebProjectsCard.tsx:214-250` and `WebAccountCard.tsx:162-218` — hand-built inline
  confirmations for **project deletion** and **account deletion**: two bare buttons, no focus
  management, no Escape, no focus trap, while `ConfirmDialog` provides all three.
- **P1** `WebTasksCard.tsx:89` — `task.status.replace("_", " ")` renders **English enum values**
  (`timed out`, `succeeded`, `queued`) to the reader.
- **P1** `UsageCard.tsx:43-44`, `:53` — 「输入 token / 输出 token」 and raw model ids on a
  clinician's billing view; `:41` `grid-cols-3` with no breakpoint puts three `text-title` numbers
  side by side on a phone.
- **P2** `ConnectorsCard.tsx:142` placeholder 「粘贴 JWT 令牌」; `:97` error with no retry.
- **P2** `DataFlowCard.tsx:22`, `:34-45`, `:60-68` — still branches on `hosted` and carries copy
  about 「本机」/「本地运行」/「MCP 服务器」 for a form deleted 2026-09-04.
- **P2** `PluginsCard.tsx:90-97` — a 5 s poll **not** gated on visibility (capped at 24 polls);
  `:314` a `<Button role="switch" aria-checked>`; `:26`/`:318` 「请求超时（毫秒）」.
- **P2** `WebReadinessCard.tsx:133-188` — `check.code ?? "check_failed"` plus raw `mode`,
  `profile`, `tenantModel`, `sandboxMode`, `networkEgress`, `networkPolicy`, `releaseId`,
  `revision`. Appropriate for an operator; see the P0 above about who is looking.
- **P2** all six operator cards hand-roll their `<section>` shell and their refresh icon button
  instead of using `ui/Card` and `Button`.
- **P2** `SettingsPage.tsx:43-48` — the standalone header is dead code; the only entry point
  passes `embedded`.

## `/login` — `LoginPage.tsx`

- **P1** `:42` — 「登录服务暂时不可用」 is set, but the form still renders with `methods === null`
  and there is no retry.
- **P2** `:105` — `PageTitle page="登录"` stays 「登录」 while the form says 注册 EviMed (`:107`).
- **P2** `:160-169` a bare `<button>` for the register/login toggle in a file that imports
  `buttonClasses` at `:16` and uses it at `:119`.
- **P2** `:96` `max-w-[420px]`; `:104` `tracking-[0.18em]` on Chinese (§2.5).
- **P2** `:52-64` `signInMessage` is declared at column 0 inside the component and re-created on
  every render.
- **Good:** `:52-64` and `:191-199` map auth codes to distinct Chinese sentences (item U12).

## `*` — `NotFound.tsx`

- **P2** `:12` — 「404 · 页面不存在」 puts a raw HTTP status in the reader's headline.
- **P2** `:15-21` — the home link is hand-styled instead of using `buttonClasses()`.

## Shared components

### `components/command-palette/CommandPalette.tsx`

13 entries, all Chinese, two groups (`:77-88` 导航, `:91-95` 动作).

- **P1** `:101-106` — **not a dialog**: a plain `<div>` overlay with two `eslint-disable`s, no
  `role="dialog"`, no `aria-modal`, **no focus trap**. Tab from the cmdk input walks into the page
  behind it.
- **P1** `:138` `value={a.label}` — only the Chinese label is searchable. `settings`, `files`,
  `memory` and pinyin all match nothing, and `hint` is explicitly excluded (`:26`).
- **P1** — six existing destinations are missing: 学习方法, 数据源, 运维台, the shortcut panel,
  collapse-sidebar, sign out.
- **P1** — discoverability: the only trigger is ⌘/Ctrl+K (`:46-50`); nothing in the chrome
  advertises it, and the only place it is documented is `ShortcutHelp`, which is itself
  keyboard-only (`?`). Neither is reachable without already knowing the other.
- **P2** `:94` 「切换主题」 blind-cycles three values and its hint names the *current* theme.

### `components/ui/ShortcutHelp.tsx`

- **P1** `:80-86` — `role="dialog" aria-modal="true"` but **no Tab trap**; only the panel is
  focused (`:53`) and Tab escapes immediately. `ConfirmDialog.tsx:94-116` has the trap.
- **P2** `:62-67` lists four shortcuts and omits Escape-to-close, the inspector overlay's Escape
  (`RightPane.tsx:138-146`) and the palette itself.

### `components/ui/Toaster.tsx`

- **P1** `:62-69` — the message text *is* the expand control, so its accessible name is the whole
  toast and `aria-expanded` is announced with no label saying what expands.
- **P2** `:45-47` — `role="alert"` wraps interactive buttons, so an assertive region announces
  the action and close labels along with the message.
- **P2** `:53` `max-w-[70vw]` — on a phone that is a 70 %-width truncated line.
- **Good:** pause on hover/focus, explicit close, undo slot.

### `components/ui/ConfirmDialog.tsx`

- **P1** `:82` — **the confirm button is always `bg-error`**. There is no `tone` prop, so every
  confirmation in the product is styled as destructive, including
  `MemoryPage.tsx:511` (确认这条敏感记忆), `AutopilotPage.tsx:357` (现在就跑一回合) and
  `PluginsCard.tsx:350` (恢复配置版本 N).
- **P2** `:65` `aria-label={title}` instead of `aria-labelledby` at a real heading; `:69` the
  title is a `<div>`, so the dialog contributes no heading to the outline.
- **P2** `:40` — Enter confirms from anywhere in the dialog that is not a `<button>`. No dialog
  has a field today; the next one will.
- **P2** `:74-86` two bare `<button>`s where `Button` with `variant="ghost"`/`"danger"` exists.
- **Good:** focus trap `:94-116`, focus restore `:46`, Escape, `role="presentation"` overlay.

### `components/ui/Button.tsx` · `Card.tsx` · `Input.tsx` · `SegmentedControl.tsx`

- **P1** `Button.tsx:42` `focus-visible:ring-offset-1` with no `ring-offset-color` → a white halo
  on dark surfaces (§2.1).
- **P1** `Card.tsx:34-39` — always a `<section>` with a hard-coded `<h2>`, so a Card nested under
  an existing `<h2>` (`AutopilotPage.tsx:389-394`, `:419-420`) produces sibling `h2`s, and a Card
  with no title is an **unnamed `section` landmark**.
- **P2** `Card.tsx:37` — `header` silently wins over `title`+`hint`, so
  `SourceUnderstandingPanel.tsx:109` passes three props of which two are dead.
- **P2** `SegmentedControl` has no `disabled` prop (see `CapsulesPage.tsx:119`).

### `components/layout/WorkbenchTabs.tsx`

Tabs are `?tab=<key>`; the first tab omits the param (`:9`, `:41-42`, `:49-50`). Deep links and
reload work, and the router's legacy redirects land correctly.

- **P1** `:51` — `setParams(next, { replace: true })` **contradicts the file's own contract**
  (`:26-27`: "so the browser's back button returns to the view it left"). With `replace`, Back
  leaves the destination entirely.
- **P1** `:110` — only the active tab is mounted, so every switch unmounts the other view and
  refetches it from scratch, losing scroll position.
- **P2** `:42` — an unknown `?tab=zzz` silently renders tab 0 **and leaves the bad value in the
  URL**.
- **P2** `:68` — `flex gap-1` with no `overflow-x-auto`; AccountPage's four tabs overflow on a
  narrow window with no scroll affordance.
- **P2** `:48` — all other query params are carried across tabs, so `?record=` / `?digest=`
  follow the reader into an unrelated tab.
- **Good:** full WAI tablist semantics (`:68-90`).

### `components/inspector/RightPane.tsx`

- **P1** `:159-161` `OverlayPane` covers the viewport with **no `role="dialog"` / `aria-modal`**,
  so the page behind stays in the accessibility tree and the tab order; only Escape closes it
  (`:138-146`, which correctly yields to open modals/menus). Same at `:85-88`.
- **P1** `:103-116` — the resize divider is a `<div>` with pointer handlers only: no
  `role="separator"`, no `aria-label`, no `aria-valuenow`, **no keyboard resize**. The same is
  true of the sidebar's divider (`Sidebar.tsx:272-288`). This is earlier item **P2-10**, still
  open.
- **P2** `:169-174` `PaneTitlebarInset` is dead code — `const overlayTitlebar = false;` makes it
  return `null`, and the body it never reaches carries `data-tauri-drag-region`, a leftover from
  the desktop shell deleted 2026-09-04. It is still called from three headers.

### `components/inspector/FilePreviewInspector.tsx`

- **P1** `:579` — `const tooLarge = /too large/i.test(error)`: **the large-file branch is selected
  by an English substring of a message the product intends to be Chinese.** The moment the error
  dictionary is completed, the large-file card silently disappears. This is exactly the
  "regex never does language" defect of principle 1.
- **P1** `:254-263`, `:597` — an error other than "too large" is one grey line with **no retry**;
  `:120-121` swallows every claim-matrix and verification failure silently, so a report renders
  with no 「依据」 markers and no explanation.
- **P2** `:696-716` `ToggleBtn` is a bare `<button>` with **no `type`, no `aria-pressed`, no
  tablist role**, used for 预览/源文件 (`:215-220`) and 表格/图表 (`:536-541`).
- **P2** `:212` renders `{data.artifact}` — the raw artifact-kind enum as a chip beside the
  filename; `:637` `toLocaleString("en-US")` in a zh-CN UI; `:639-648` raw `format`/`dtype`/
  `shape`/`path`.
- **Good:** `:37-49` thirteen lazily loaded viewer chunks with a shared fallback.

### `components/markdown-viewer/` — how a delivered report is actually read

The report opens in the right-pane inspector on a document-white page
(`FilePreviewInspector.tsx:427-433`), preceded by a `ClaimSummary` and rendered by
`MarkdownViewer variant="document"` with the claim matrix and per-claim statuses.

- **P0 — there is no table of contents.** `MarkdownViewer.tsx:131-134` maps `h1`–`h4` to styled
  headings and emits **no `id`s and no anchors**; there is no outline, no sticky nav, no
  in-document search. A 62 KB clinical evidence report is one unindexed scroll in a 1 024 px
  drawer. (`grep -r 'toc|TableOfContents|目录' components/markdown-viewer/` → nothing.)
- **P0 — there is no export, print or copy path for the report.** The only affordances are the
  inspector's raw-`.md` download (`FilePreviewInspector.tsx:233-240`) and a per-code-fence copy
  button (`CodeBlock.tsx:41`, `:62`). No copy-as-text, no print, no PDF, no "copy this citation",
  and **no `@media print` rule anywhere in `index.css`** — printing the browser page prints the
  app chrome. For a product whose deliverable is a report a clinician must circulate, this is the
  largest single gap on the read path.
- **P1** `ClaimCitation.tsx:63-72` — the popover is well built (a real `<button>`, a full Chinese
  `aria-label`, `min-h-6`, `max-w-[calc(100vw-2rem)]`), **but there is no ✓ glyph**: the verified
  case is 「依据」 in `text-accent` and the unverified case is 「依据 ⚠」 in `text-warn`. Verified
  vs unverified is therefore carried by **colour alone** for every claim that is fine — which is
  the majority. Add a ✓ to the verified label; the shape is the accessible carrier.
- **P1** `ClaimCitation.tsx:94`, `:86` — the raw claim id (`CLM-001`) is printed in the popover
  header and again in the miss case; `:95` 「把握度 {claim.confidence}」 renders whatever string
  the model wrote, unmapped.
- **P2** `MarkdownViewer.tsx:25-28` vs `:54-57` — the `chat` variant uses Tailwind's default
  `text-2xl/xl/lg/base` while `document` uses the token scale. The file is exempted from the
  token lint (`apps/web/.eslintrc.cjs:91`) and the two variants have drifted.
- **P2** `MarkdownViewer.tsx:57` — `h4` is `uppercase tracking-[0.08em]`, which on Chinese
  headings produces spaced-out CJK (§2.5).

### `components/sources/SourceUnderstandingPanel.tsx`

- **P1** `:161-165` — 「模型：{modelId} · 提供方：{providerId} · 输入 N tokens · 输出 N tokens」
  and 「运行：{run.id}」, unfolded, on a clinician's screen; `:160` 「实际费用 ¥0.00123456 CNY」
  (both ¥ and CNY, eight decimals). `:164-165` is also the last bare `<a href>` in the shell,
  and it **full-reloads the application**.
- **P2** `:119` `DEPTH_LABELS[detail.depth]` has no fallback and renders `undefined` for a new
  value; `:180` 「方法草稿尚未发布为胶囊技能」 uses a term that appears nowhere else.
- **Good:** `:74-86` a visibility-gated 5 s poll, and the best four-state discipline in the sweep
  (`:114-145`, including distinguishing *failed* from *never analysed*).

---

# Section 4 — earlier-audit items still not done

Verified against current code, not against the earlier reports' own claims. Items whose subject
was deleted (the desktop shell on 2026-09-04, the usememos module) are marked MOOT and are not
debt. Everything in the 2026-09-15 walk's A/B/C/D/E series landed except where listed.

## Never started

| id | Report | Item | Evidence it is absent |
|---|---|---|---|
| **P2-3** | 03-迭代任务清单 | an i18n layer (react-i18next) | no i18n dependency in `apps/web/package.json:15-40`; every string is inline Chinese. This is what makes §1f (English validator text) unfixable at the presentation layer. |
| **P2-5** | 03 | onboarding / first-run guidance | no onboarding surface anywhere in `apps/web/src`; the only first-run artefact is `ConnectorPrompt`, which is a credentials notice (§1.7). Directly connected to complaint 2 — nothing explains what a project is. |
| **P2-10** | 03 | `?` help panel **+ keyboard pane resize + j/k list navigation** | the help panel landed (`ui/ShortcutHelp.tsx`); **the resize half did not**: neither `Sidebar.tsx:272-288` nor `RightPane.tsx:103-116` has `role="separator"`, `aria-label`, `aria-valuenow` or arrow-key handling. No j/k on any list. |
| **P1-10** | 03 | hosted run ledger should not fetch the whole list | `RunsPage.tsx:265-267` still says "no server-side paging or facets"; `:343-362` filters client-side over every run the account has ever had. |
| **P3-6** | 03 | account-level login backoff + password recovery | only IP limiting exists (`apps/server/src/server.mjs:3450-3452`); `LoginPage.tsx` has no recovery link. |
| **D7** | 2026-09-15 walk | two 403s per kernel load (`syncInspectManifest`) | `packages/harness-port/seam-manifest.json:170` still lists it as `denied`; F7 re-observed the console noise on 2026-09-18. Harmless, but it is the first thing in the console on every session open. |
| **E2** | 2026-09-15 walk | July acceptance runs still occupy the first page of history | a data decision; `scripts/ops/capability-acceptance.mjs:51` still defaults to `cdss-access`. Partly discharged by the 2026-09-17 project archive (00-live-findings, "Done"). |
| **§3.7** | 2026-09-16 review | a memory row should show which runs used it (`servedIn`) | `grep -rn servedIn apps/server/src` → no hits. The reverse view exists on the run (`RunsPage.tsx:720-739`). |
| **P2 #15b** | 2026-09-16 review | external-agent observation report-back | `apps/server/src/learningRoutes.mjs:92-114` exposes `/api/methods` only; no observation endpoint. |
| **D4 (half)** | 2026-09-16 review | `knip` into lint | no `knip` config or script in the repo. `RightPane` and `FilesPage.tsx:266 SessionFilesPane` are now referenced only by their own tests, and `RightPane.tsx:169-174` is provably dead (`const overlayTitlebar = false`). |

## Partially done — the missing half

| id | Report | What landed | What did not | Evidence |
|---|---|---|---|---|
| **P1-4** | 03 | search + live status dot on the session list | **no rename, no delete, no undo-delete** for a session | `Sidebar.tsx:222-234`, `:256-258`; sessions are kernel-owned and the shell exposes no mutation |
| **P1-14 / U14** | 03 / 2026-09-16 | `lib/format.ts` is the shared module | three formatters still bypass it | `MemoryPage.tsx:44-49`, `CapsuleTransferPanel.tsx:63`, `:119`, `ProvenancePanel.tsx:223`; `RunsPage.tsx:1076-1087` adds a fourth |
| **P2-7** | 03 | capability copy moved to `@evimed/domain` | not served per deployment; the frame's copy is process-memoised | `runtimeUiServer.mjs:233` caches `capabilityCards` for the process lifetime (§1.5b) |
| **U10** | 2026-09-16 | nav is `Link`s, tabs are WAI tabs, inbox uses `Link` | **one bare `<a href>` survives and full-reloads the SPA** | `SourceUnderstandingPanel.tsx:164-165` |
| **U13 / D3-vocab** | 2026-09-16 | account and settings cleaned of internal words | the same panel leaks model id, provider id, run id and an 8-decimal cost | `SourceUnderstandingPanel.tsx:160-165`. Not covered by `app/vocabulary.test.tsx:64-95`, which is still runs-page-only. |
| **D3** | 2026-09-16 | sidebar and runs polls gated on visibility | two polls still are not | `NotebookEditor.tsx:80-98` (2 s full-file re-read, ungated) and `PluginsCard.tsx:90-97` (5 s, ungated) |
| **D5** | 2026-09-16 | `WorkbenchTabs`, `router`, `runPresentation` tests added | no `SessionRoute` test; no `KnowledgePage`/`MemoryHubPage`/`OpsPage` tests; the vocabulary regression covers only the run ledger | `app/vocabulary.test.tsx:64-95` |
| **D1** | 2026-09-16 | route-level code splitting landed | the entry chunk is 686 KB, above the ~300 KB target | `dist/assets/index-*.js`; `MarkdownViewer` and `CodeViewer` are still eager (`FilePreviewInspector.tsx:18-19`, `MemoryPage.tsx:22`, `MethodsPage.tsx:9`) |
| **M1** | 2026-09-16 | injected briefs are labelled and archivable one by one | no bulk "archive all system inferences" | `MemoryPage.tsx:375` per-record only; `components/memory/MemoryControls.tsx:147` is a full reset |
| **M4 ①** | 2026-09-16 | sensitive-memory confirm, recall echo, pause/reset all landed | an inbox memory notice still only deep-links to the memory page instead of offering confirm/reject/delete in place | `InboxPage.tsx:148-151` |
| **§6.2-3** | 2026-09-15 | the shell-owned run panel was retired | it was not replaced by a kernel right-bar tab either | `grep 'sidebar.right' runtimeUiShell.mjs` → none; F2 confirms the right pane is empty and 「新标签页」 opens nothing |
| **P2 #14b** | 2026-09-16 | `PlanSteps` (deliverables as steps) | no source counts, no soft ETA, no coverage curve — and §1.4g shows the step statuses themselves are wrong for delegated work | `RunsPage.tsx:946-978` |
| **P0-8** | 03 | favicon/theme-color moved off the upstream blue | `evimed-mark.svg` is drawn in **`#2563EB`**, the same upstream blue, and is now the brand mark and the favicon | `apps/web/src/assets/evimed-mark.svg:2`, `:5`; `index.html:6` (§2.3) |
| **§6.3-4** | 2026-09-15 | the walk script landed as `scripts/ops/ui-walk.mjs` | it is `pnpm walk:ui` (`package.json:33`) and is **not** part of `test:web:e2e` (`:32`) | so nothing in CI opens a page |

## Outside `apps/web`, still open (from 03-迭代任务清单 P3)

**P3-1** silent module failure — `项目代码/科研选题/app/main.py:615-618` still swallows a failed
module without telling the frontend. **P3-2** the OpenGWAS token is still collected by pasting it
into chat — `项目代码/孟德尔随机化/start.py:744-751`. **P3-5** the `lx-manus` audit was never
done (repo absent). **P3-4** the `科研选题` port inconsistency is documented rather than fixed
(`AGENTS.md:102`, `:104`, `:121`).

---

# Section 5 — the fifteen highest-leverage shell changes, in order

Ordered by (reader harm × reach) ÷ size. Size: **S** ≈ under a day, **M** ≈ 1–3 days,
**L** ≈ a week or more.

| # | Change | Why it is here | Size | Files |
|---|---|---|---|---|
| 1 | **Stop showing raw English validator sentences.** Carry `GateIssue.code` through `qualityNotices` instead of a flattened string; key the Chinese label off the code; move `NOTICE_GROUPS`/`summarizeQualityNotices` into `@evimed/domain` and call them from `runFinishedNotice` too. | It is the product's core output — the verdict on a clinical package — rendered in a language the reader does not read, on both the run row and the inbox. Eleven regexes over English prose is also the exact shape principle 5 bans; the comment at `runPresentation.ts:210-212` already names this fix. | **M** | `packages/domain/src/clinicalEvidence.mjs`, new `packages/domain/src/gateNotices.mjs`, `apps/server/src/agentRuns.mjs:2225-2243`, `apps/server/src/notificationService.mjs:134-139`, `apps/web/src/lib/runPresentation.ts:213-282`, `apps/web/src/app/routes/RunsPage.tsx:690-713` |
| 2 | **Fix delegated plan-item status, and the false stall notice.** Take `delegated`/`submitted`/`rejected` and `attempts` from the projection when the item is in `subagents`; keep `accepted` gated on a witnessed acceptance. Reset the progress counter on child activity, and delete the 「工作区也没有变化」 clause the monitor never measured. | For 25 minutes the product told the owner their running analysis had not started, and then told them it was stuck. Both statements were false and both are on the same code path. | **M** | `apps/server/src/agentRuns.mjs:883-907`, `:4539-4662`, `:4719` |
| 3 | **Pass the theme into the frame.** `evimed.runtime-ui.theme` message → bridge → kernel colour-scheme attribute; tint the kernel's `--dsw-*` action colour from `--accent` in the injected stylesheet. | Dark mode currently produces a dark shell around a white conversation. The conversation is the product. | **M** | `apps/web/src/app/routes/RuntimeUiFrame.tsx`, `apps/web/src/app/providers/ThemeProvider.tsx`, `packages/harness-port/src/runtimeUiBridge.mjs`, `packages/harness-port/src/runtimeUiShell.mjs:287-336` |
| 4 | **Make the session open feel like 2 s.** Split the `no-store` rule so static assets get `max-age + immutable` with their etag; stabilise the frame prefix per project (frame id in the cookie value, not the path); render a composer skeleton and a named, advancing stage while it loads. | 10–11 s of grey text on the main surface, on every visit, and it never improves with a warm cache because the URLs change every mount. | **M** (caching) + **S** (skeleton) | `apps/server/src/runtimeManager.mjs:356-363`, `apps/server/src/runtimeUiFrames.mjs:71`, `:94-97`, `apps/web/src/app/routes/RuntimeUiFrame.tsx:360-391`, `apps/web/src/app/routes/SessionRoute.tsx:86-101` |
| 5 | **Give reports a table of contents, an export, and a print stylesheet.** Heading ids + a sticky outline in `MarkdownViewer variant="document"`; a 「导出」 menu (copy as Markdown / print / PDF via print); `@media print` in `index.css`. | The deliverable is a 60 KB clinical report and the only way to read it is one unindexed scroll in a drawer; the only way to share it is downloading raw Markdown. | **M** | `apps/web/src/components/markdown-viewer/MarkdownViewer.tsx:54-134`, `apps/web/src/components/inspector/FilePreviewInspector.tsx:233-240`, `:427-433`, `apps/web/src/index.css` |
| 6 | **Make the inbox clearable and its bodies human.** `POST /api/inbox/read-all`; 「全部标为已读」 on the page; drop the `actions.length === 0` condition on 「标为已读」; coalesce run-finished notices by day; suppress notifications for eval/autopilot dispatches; add a retention sweep. | Today the commonest item in the inbox cannot be marked read at all, and 29 of 31 unread items on the production account were machine-generated. | **M** | `apps/server/src/notificationRoutes.mjs:34-59`, `apps/server/src/notificationService.mjs:154-211`, `:275-286`, `apps/server/src/server.mjs:1376-1402`, `apps/web/src/lib/inboxClient.ts`, `apps/web/src/app/routes/InboxPage.tsx:93-105`, `:154` |
| 7 | **Projects get names, a rename, and one sentence of explanation.** Name field in any language + auto-slugged id; `PATCH /api/projects/:id`; rename in the switcher and the projects card; 「Default Project」 → 「我的研究」 with a one-time migration; one muted line under the switcher list saying what a project scopes. | The first thing under the wordmark is English, cannot be changed, cannot be written in Chinese, and nothing anywhere says what it does — while it silently scopes the container, the workspace, the runs, the files and half the memory. | **M** | `apps/server/src/server.mjs:3004-3031` (+ new PATCH), `apps/server/src/store.mjs:571`, `:1035`, `:1075-1087`, `apps/web/src/components/sidebar/ProjectSwitcher.tsx`, `apps/web/src/lib/projects.ts`, `apps/web/src/components/settings/WebProjectsCard.tsx` |
| 8 | **Fix the bell.** 16 px icon in a 28 px target, 16 px badge at −4 px with `ring-2 ring-surface`, a `badge: ["11px","1"]` rung, and a real `unreadTotal` from the API instead of a page length. | The owner's first complaint, four lines of code, and the count is also wrong above 50. | **S** | `apps/web/src/components/sidebar/Sidebar.tsx:76-88`, `:173-185`, `apps/web/tailwind.config.js:38-45`, `apps/server/src/notificationService.mjs:213-238`, `apps/web/src/lib/inboxClient.ts:39-43` |
| 9 | **Make a run row say what run it was.** Backfill `question` from the first user message; strip the `请以「…」能力完成以下任务：` preamble when making a title; add a second line (time + outcome) to sidebar and ledger rows; use `runDotClass` on the ledger; suppress the capability tag when it equals the title; give the four non-running dots a label. | Eleven identical rows is the owner's third complaint, and 23 of 25 production runs are in the state that causes it. | **S**–**M** | `apps/server/src/agentRuns.mjs` (backfill), `apps/web/src/lib/runPresentation.ts:20-47`, `apps/web/src/components/sidebar/Sidebar.tsx:239-253`, `apps/web/src/app/routes/RunsPage.tsx:563-590` |
| 10 | **Stop rendering errors as emptiness.** One shared `<LoadFailure message onRetry stale>` (lift `RunsPage.tsx:228-242`) and use it in the eleven places listed in §3. | An outage that reads as "you have nothing" is the failure mode that costs the most trust, and it is currently the default across the shell. | **M** | `apps/web/src/components/cards/` (new), `FilesPage.tsx:71-78`, `NotebooksPage.tsx:28-32`, `MemoryPage.tsx:421-439`, `WebProjectsCard.tsx:153`, `WebAccountCard.tsx:122`, the six operator cards |
| 11 | **Guard and frame the operator surface.** Restore the 「仅运维账号可见」 banner inside the embedded tab; put a `ConfirmDialog` in front of 停止/重启 the runtime; replace the two hand-built deletion confirmations with `ConfirmDialog`; translate `WebTasksCard.tsx:89`. | One click stops a running analysis with no confirmation, and the console that offers it has lost the sentence saying what it is. | **S** | `apps/web/src/app/routes/OpsPage.tsx:42-47`, `apps/web/src/components/settings/WebResourcesCard.tsx:106-135`, `WebProjectsCard.tsx:214-250`, `WebAccountCard.tsx:162-218`, `WebTasksCard.tsx:89` |
| 12 | **Promote the capability dock and make it non-destructive.** Open by default, real tokens, grouped by category, duration visible; a click in an existing session fills that composer instead of creating a new one. | It is the only place a first-time user learns the fifteen capabilities exist, and today it is a 60 %-opaque grey line that abandons the conversation when used. | **S** (dock) + **M** (in-place draft) | `packages/harness-port/src/runtimeUiShell.mjs:176-193`, `:239`, `packages/harness-port/src/runtimeUiBridge.mjs:186-200`, `apps/web/src/app/routes/RuntimeUiFrame.tsx:264-281` |
| 13 | **Move the credentials banner off every page.** A count badge on the 「账户与设置」 row by default; the prompt inline on the run row whose source actually needed a credential. | A deployment-level condition the reader usually cannot act on, taking the top of seven of eight pages. | **S** | `apps/web/src/components/settings/ConnectorPrompt.tsx:28-36`, `apps/web/src/app/layout/AppShell.tsx:114`, `apps/web/src/components/sidebar/Sidebar.tsx:260-265` |
| 14 | **Contrast, tokens and the brand mark.** Delete the eight `text-muted/50|60|80` and `opacity-70` alpha suffixes; add `ring-offset-color`, a `--border-control` at ≥3:1, and the `badge`/`wordmark` rungs; recolour `evimed-mark.svg` and the frame's `Mark`/favicon to one hue; settle one H1 rung. | Three sub-AA text colours, a white focus halo in dark mode, three brand colours and two H1 sizes — all one-line changes with no behaviour risk. | **S** | `apps/web/src/index.css`, `apps/web/tailwind.config.js`, `apps/web/src/assets/evimed-mark.svg`, `packages/harness-port/src/runtimeUiShell.mjs:61-66`, `:133-137`, the eight alpha call sites in §2.2 |
| 15 | **Make the shell's overlays real dialogs, and the palette findable.** `role="dialog"`/`aria-modal` + focus trap on `CommandPalette` and `RightPane.OverlayPane`, a Tab trap in `ShortcutHelp`, a `tone` prop on `ConfirmDialog`, `role="separator"` + arrow-key resize on both dividers (**P2-10**), search aliases and the six missing entries in the palette, and a visible affordance pointing at ⌘K. | Four overlays that trap nothing, one confirm button that calls every action destructive, two mouse-only dividers, and a command palette nobody can discover — the whole keyboard/a11y layer of the shell in one pass. | **M** | `apps/web/src/components/command-palette/CommandPalette.tsx`, `apps/web/src/components/ui/ShortcutHelp.tsx`, `apps/web/src/components/ui/ConfirmDialog.tsx`, `apps/web/src/components/inspector/RightPane.tsx`, `apps/web/src/components/sidebar/Sidebar.tsx:272-288` |

**Sequencing note.** 1, 2 and 9 all touch the run record and should ship together; 3 and 4 both
touch the frame boundary and should ship together; 8, 11, 13 and 14 are independent small changes
that can land the same day. Items 5 and 6 are the two that most change what a researcher can
*do* with a finished run, and neither depends on the others.

**Not in this list, deliberately.** An i18n layer (**P2-3**) and onboarding (**P2-5**) are the two
largest missing pieces and both are **L**. i18n becomes cheap once item 1 replaces prose with
codes; onboarding becomes meaningful once item 7 gives a project a name worth explaining. Both
should be planned after those land, not before.

---

*End of report.*
