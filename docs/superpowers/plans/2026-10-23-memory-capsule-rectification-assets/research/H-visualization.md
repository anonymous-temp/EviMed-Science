# H. Memory capsule visual presentation: review, gap list, market research, redesign (2026-10-23)

Read-only review at `main` (HEAD 69808e1cd plus uncommitted frontier work, which does not touch this slice). No server or browser was started; no secrets were read. Paths are relative to `OpenScience/` unless absolute. Labels: VERIFIED = read in code at the cited place; INFERRED = follows from code plus the production facts handed over by the coordinator (owner account on the native engine, zero memory files, zero learned methods, no capsule ever shared); I could not read production data, so every statement about "what the owner sees" is INFERRED from code.

Structure: 1 what exists today, view by view and engine by engine, and why it reads as "not built" · 2 gap list against the prior designs · 3 how mature products show user memory (web research, 2025-2026) · 4 redesign proposal for the 记忆胶囊 landing.

---

## 1. What exists today

### 1.1 The page, in one paragraph

`/app/memory` redirects a plain visit to `/app/memory/map` when `me.features.memoryMap` is on (default) (`apps/web/src/app/routes/MemoryHubPage.tsx:101-104`, VERIFIED). The map page is `MemoryFrame` titled 「记忆胶囊」 with four tabs, 地图 · 关于你 · 项目 · 做法 (`components/memory/MemoryFrame.tsx:12-28`), one toolbar row with five view chips (关系 · 主题 · 维度 · 时间 · 活跃) over one selection kept in the address, one `Headline` sentence, one chart card, and the same marks as a list under the canvas (`app/routes/MemoryMapPage.tsx:69-218`; `components/memory/map/mapToolbar.ts:9-12`, VERIFIED). Every mark opens the memory page's own `FactDrawer` or `MethodDrawer` (`components/memory/map/MapDrawer.tsx`, VERIFIED). The three list tabs are lists only; the 「成长」 chart tab was deleted on 2026-10-17 and `?tab=growth` now lands on the map's time view (`MemoryHubPage.tsx:106-110`, `DESIGN.md` lines 113-118, VERIFIED).

So the thing that was built is faithful to the 10-12 design (`course-correction-20261012/visualization.md` §2/§5): five views, one selection, one drawer, a data-page exception. It is a **memory-record explorer**. It is not a picture of a capsule.

### 1.2 What feeds it

`GET /api/memory/map` assembles one document from independent sources (`apps/server/src/memoryMap.mjs:245-441`; sources wired at `apps/server/src/server.mjs:5019-5037`):

| Source | Gives | Stands aside / limits |
|---|---|---|
| `records` (`memoryMapSources/records.mjs:285-295` (pure part `recordsContribution` 196-283)) | memory marks (`memory:<id>`), `belongs-to` (to project or `you`), `rests-on` (document/DOI/card/frontier item, with state), `replaces`, `conflicts` edges; supersede lanes; radar "各方面记了多少"; memory events | **legacy engine only** (`applies: engine !== "native"`) |
| `native-memory` (`memoryMapSources/nativeMemory.mjs:53-64`, `nativeMemoryStore.mjs:442-461`) | the same shapes, from the engine's files | native only. Every record has `importance: 0.5`, `usage: {}`, `supersededBy/validFrom/invalidSince: null`, `conflicts: []` (`nativeMemoryStore.mjs:253-296`, 454-455). So: all marks one size, no `replaces`, no `conflicts`, no lanes, no 合并 bars |
| `documents` (`memoryMapSources/documents.mjs`) | uploaded knowledge-base documents as ■ marks, `belongs-to` project | at most 8 projects x 100 docs; compiled wiki/KG mirrors excluded |
| `knowledge-graph` (`memoryMapSources/knowledgeGraph.mjs:248-259`; `knowledgePageService.mjs:1052-1062`) | entities and wiki pages | **only when the map is narrowed to one project**; `fetchProducts` returns null for the account-wide map, which is the landing |
| `methods` (`memoryMapSources/methods.mjs:21-43`) | ▲ marks for approved learned methods, hanging from `you` | account-wide scope only (`request.projectId === null`), 40 at most, `approved` only |
| `activity` (`memoryMapSources/activity.mjs:70-98`) | calendar buckets (conversations, methods, corrections) for the last year | counts only; conversations are never listed |
| `runs` (`memoryMapSources/runs.mjs:118-130`) | radar "在做什么": share of the last 30 days' finished conversations by task type, ghost = previous 30 | needs a model-judged `taskType` per run |
| `topics` (`memoryMapSources/topics.mjs`; `memoryTopics.mjs`) | model-grouped topics, rename/merge/dismiss | built from `accountMemoryRecords` for both engines, but **only with at least 12 eligible memories** (`config.mjs:3200-3201`, default 12) |

Never on the map, whatever the engine (grep of `capsule` in `memoryMap*` returns nothing, VERIFIED): the capsule's own facts (the 10 「项目笔记」 `project_fact` documents), received packs (收到的胶囊), exports and shares sent, handbooks, learned-method history and its growth moments, and the native engine's conversation provenance. `/api/memory/growth` and `/api/memory/learned` still compute the old growth line and the "哪天学会了什么" list but have no web caller (`D-api-ui.md` §4.2; `memoryTimeline.mjs:413-503, 618-640`, VERIFIED).

### 1.3 View by view, by engine and by size of account

"Eligible" below means active, non-sensitive, non-run-summary. L = legacy engine, N = native engine.

| View | What it draws (code) | 0 records | 3 records | 20 records | 200 records |
|---|---|---|---|---|---|
| **关系** (`GraphView.tsx`, `charts/map/layout.ts`, `mapModel.ts:134-136`) | one fixed sunflower-spiral plan: `you` in the middle, each project a hub, its marks on a spiral; edges only `belongs-to`, `rests-on`, `replaces`, `conflicts` (+ `links`/`relates` when a project graph exists). Replay slider appears with 2+ stops | **Thin** (no mark besides `you`): no chart; 3 `StatTile`s (记忆 0 · 资料 0 · 需要看一眼 0) and a `Note` 「再多聊几次，这里会长出你的地图」 (`MemoryMapPage.tsx:151-163`). But if the account has documents or methods the map is **not** thin and draws projects hanging documents under the sentence 「还没有记住什么。」 (`mapModel.ts:96`). **INFERRED for the owner** | a star: 3 dots round one hub. Drawn (sparse records are kept). Replay needs 2+ distinct start moments | readable star-of-stars; most memories link only to their project, so the edges say "belongs to" and nothing else | overview folds to 150 marks, rest become `cluster:` marks (`memoryMap.mjs:133-189`); the picture is a hub-and-spoke plan, not a relation map |
| **主题** (`TopicsView.tsx`, `WordCloud.tsx`) | model groups; cloud of words sized by member count + ranking list with trend, rename/merge/dismiss | empty `ChartCard`: 「记下的内容还不多…」 | same (below 12) | up to ~4 topics by the prompt's own guide ("twenty memories make about four topics", `memoryTopics.mjs:48`); a cloud of 4 words | up to 30 topics; this is the only view designed for this size |
| **维度** (`DimsView.tsx`, `radarOption.ts:17-36`) | two radars: 在做什么 (30-day share by work type, ghost = previous 30) and 各方面记了多少 (count by 6 fixed aspects, ghost = 30 days ago). Radar only if total >= 6 and >= 3 axes used; else bars; else a sentence | sentence 「记下的内容还不多…」 and, for the work radar, 「最近 30 天的对话还不多」 | memory side: bars of 3 numbers | radar if 3+ aspects have content, else bars | radar |
| **时间** (`TimeView.tsx`, `changeWeeks.ts`) | card 1: weekly stacked bars 记下 / 合并 / 忘记 (only memory and method events); card 2: lineage lanes (supersede chains) + event dots | empty `ChartCard` 「还没有记下的事，时间线会在这里长出来。」 | one or two bars of 1-3; no lanes (L: only if a statement was replaced; N: never, `supersededBy` is always null) | bars across the weeks that exist; lanes only for L | bars + lanes (L), bars + dots (N). Cut at the newest 500 events (`MAP_EVENT_CAP`) |
| **活跃** (`ActivityView.tsx`) | calendar heat of the last year: memory + run + method + feedback counts per day (conversations counted here, not listed) | empty card 「一年里还没有记录…」 only if the account has no conversation at all; **conversations count**, so an account with chats and zero memories still paints days | few cells | real picture | real picture |

Cross-cutting (VERIFIED): the sentence over the picture is `EviMed 记住了你的 N 件事，其中 M 件需要看一眼` (`mapModel.ts:94-103`); a failed source is named in one `LoadError` line and never becomes zeros (`MemoryMapPage.tsx:196-201`, 153; `memoryMap.mjs:261-271`). That ruling is honoured.

### 1.4 What the owner's account (native, 0 memory files) most probably sees (INFERRED)

Reading the code against the production facts:

1. Sentence 「还没有记住什么。」, or the empty state 「还没有记住什么」 with 「去对话」 if the account has no documents and no conversation (`MemoryMapPage.tsx:182-204`).
2. 关系: either the thin state (three zeros) or, if the knowledge base holds documents, projects with document marks and the sentence above saying nothing is remembered. Both look like a feature with nothing in it. The owner's 10 「项目笔记」 capsule facts are not drawn at all.
3. 主题, 时间: empty cards. 维度: the memory radar is empty; the work radar is a sentence or a needle. 活跃: a calendar that shows chats if the work radar's input exists.
4. 做法: zero (no learned methods for the owner; the methods that exist belong to the acceptance account).
5. Nothing anywhere says 「收到的」 (no capsule received) or 「分享出去的」 (none ever shared); those parts of a capsule have no picture at all.

### 1.5 Why it reads as "not built"

Ranked by how much each contributes (my judgement; each rests on verified code):

1. **The object drawn is the wrong object (VERIFIED, root cause).** The owner's vision was one capsule that fuses knowledge base, memory and self-iteration, with a timeline of the person's change and growth, and shared capsules that show how a person works (`docs/ui-ux-audit/2026-09-19-记忆胶囊-展示与使用优化方案.md` §1, V1/V4/V5; build spec A1/A3). The landing draws only the `evimed_memory` records (or native files) plus uploaded documents and up to 40 methods. Of the six parts a capsule has in the owner's own words (关于你 / 项目 / 我的做法 / 知识 / 收到的 / 成长) the landing shows none as a part; it shows an undifferentiated cloud of marks, and the part-wise reading only exists on three list tabs.
2. **For the native account the data is empty, and the design has no day-one state (VERIFIED code, INFERRED data).** Zero files for the owner means the only populated parts of the picture are things the owner did not ask for (documents as marks). The "sparse real records remain visible" ruling is implemented as "draw whatever exists", but a picture of nothing is not a day-one design; it is the absence of one. The thin state is three zeros and a sentence.
3. **Growth, the thing the owner wanted most visually, was deleted and not replaced by a capsule-level story (VERIFIED).** The old 成长 line was a stock chart that fell (75 to 42) and could not say what happened; it was replaced by weekly 记下/合并/忘记 bars. Those bars count memory events and method events only. For a native account 合并 can never exist (no supersede), `ended` is always 0, and growth "still counts capsule notes the conversation cannot see" in the unused `/api/memory/growth` (`C-memory-engines.md` D9). There is no "what I learned about you, what I learned to do for you" timeline.
4. **The graph carries no relation information (VERIFIED).** Edge types produced by memories are `belongs-to`, `rests-on`, `replaces`, `conflicts` (`records.mjs:216-252`). Production has zero conflicts, native has no replaces, and few memories rest on sources, so the typical picture is a hub-and-spoke tree: the account, a project, memories hanging from it. That is a list drawn in two dimensions. The relation a person would find meaningful (these three memories are about the same thing; this memory and that document belong together) is only available as topic membership, which is not drawn as lines and needs 12 memories.
5. **No face for the sharing half (VERIFIED).** The strongest differentiator (build spec A5, "一个人把他怎么干活交给另一个人") has neither a preview picture nor a "what I would hand over" figure on the landing. Sharing is a drawer behind a 「⋯」 menu that exists only on the three list tabs; the map page has no header actions at all (`MemoryMapPage.tsx:186-190`; `D-api-ui.md` defect 3), so the landing hides the verbs that make a capsule a capsule.
6. **Single-engine truth, two-engine product (VERIFIED).** The map draws marks the same way for both engines, but what the engine knows differs: native marks are uniform in size and have no history; native has no conversation provenance (`C-memory-engines.md` D3). The same five charts therefore look much poorer on the engine the owner is on.
7. **Smaller: the headline can contradict the picture** (「还没有记住什么」 over a populated document graph), and the walk's `memory-map` probe only needs one row of the list to press (`scripts/ops/ui-walk.mjs:3494-3500`; zero rows is merely a "not observable" notice, `memoryMapFindings`, 2269-2278), so a page full of documents and zero memories passes the release walk. Verification does not see the defect.

---

## 2. Gap list against the prior designs

Sources compared: the owner's original vision (09-19 audit §1, V1-V13, from sessions of 2026-08-23 on); the 09-19 proposal (§4.2 six sections, §4.3 overview, §4.6 timeline, §4.7 sharing); the build spec A3 and §10 (09-21); the 10-12 visualization spec (`course-correction-20261012/visualization.md` §2, §5); the 10-12 portrait review (G1-G21, V1-V32); the owner rulings of 10-12, 10-14, 10-17, 10-19. The spec's 11 figures (`docs/superpowers/specs/2026-09-21-memory-capsule-assets/`) are **absent from the tree** (only `2026-09-21-medical-frontier-feed-assets` exists), so the mock-ups themselves cannot be compared; the spec's text is used.

Status key: BUILT = as designed · DIFF = built differently · NOT = designed, not built · CUT = removed by a later owner ruling · STARVED = built, but the data for it does not reach the picture.

### 2.1 The capsule as one object (the owner's own words)

| Design | Status | Evidence / note |
|---|---|---|
| V1 one capsule per user that fuses knowledge base, memory and self-iteration (08-23) | **NOT** | Still three stores: `evimed_memory.records` or native files; `evimed_product.documents` kind `fact` (capsule facts, 项目笔记) and kind `method`. The `holder` column of spec §5.1 does not exist (`A-core-sharing.md` N1). The map draws records + uploaded documents + <=40 approved methods and nothing from the capsule's own facts, packs or handbooks (`memoryMapSources/*`, no `capsule` token, VERIFIED). |
| 09-19 §4.2 six sections: 总览 / 资料 / 理解 / 方法 / 时间轴 / 分享 | **DIFF** | Four tabs 地图 · 关于你 · 项目 · 做法 (`MemoryFrame.tsx:12`). 资料 is the knowledge base page, no data link; 分享 is a drawer behind 「⋯」 on the list tabs only; 收到的 lives in the drawer's import tab. |
| 09-19 §4.3 总览: one readable paragraph, counts per layer, 「还缺什么」 | **CUT** | 「EviMed 眼中的你」 deleted 09-22; "counts on screen are noise" 09-23; subtitle rule. The map's headline sentence is the only survivor, and counts only memories. |
| V4 a timeline in which the person sees their own change and growth (08-23) | **DIFF** | 成长 tab with line + 「哪天学会了什么」 deleted 10-17 (`DESIGN.md:113-118`). Replaced by weekly 记下/合并/忘记 bars (`changeWeeks.ts`), which count memory and method events only. `/api/memory/growth` and `/api/memory/learned` still compute the old story, no web caller (`memoryTimeline.mjs:413-503, 618-640`). For a native account 合并 can never occur and `ended` is 0. |
| V5 shared capsules as "how a person works": plug in, take effect, shown as a person's way of doing things (08-23) | **DIFF** | Preview is a `Disclosure` sentence 「对方会看到：…」 and entry rows (`CapsuleTransferPanel.tsx:182`); received packs are a shelf of rows (`ReceivedShelf.tsx`). Nothing draws a person's way of working. In-platform delivery and links are behind `OPEN_SCIENCE_CAPSULE_SHARE_ENABLED` (default off); no capsule was ever shared, so nothing exists to draw. |
| Spec A3 five questions on one page: definition · two switches · 眼中的你 · 最近变化 · 记下的内容 · 收到的/分享 | **DIFF/CUT** | Definition, 眼中的你, counts cut by rulings. Switches: present on the three list tabs, **absent on the landing** (`MemoryMapPage.tsx:186-190`; `D-api-ui.md` defect 3). 最近变化 became the 时间 view. |

### 2.2 The five views (10-12 spec) against what exists

| Spec item | Status | Note |
|---|---|---|
| V1 关系: aggregated overview with clusters, focus + depth 1-2, source chain, amber "needs a look" layer, time replay | **BUILT** | `GraphView.tsx`, `memoryMap.mjs:133-234`. Deviation: edges `read-in` / `recalled-in` (conversation read or used a memory) were designed and are not drawn; "used in" exists only in the drawer's 关联 section (`RelatedSection.tsx`). |
| V1 first-screen sentence with a number that opens what it counts | **BUILT** | `headline()` + `headlineParts()`; only the "needs a look" number is a link. |
| V1 data-thin rule: fewer than 8 nodes or 5 edges, no chart, sentence + 3 numbers | **DIFF** | Now "no node besides `you`" (`mapModel.ts:134`), per the 10-19 sparse ruling. Right direction, but no day-one design for the empty and near-empty case. |
| V2 主题: Flash grouping, 8-30 topics, cloud + ranking, rename/merge/dismiss | **BUILT, STARVED** | Works as specified; needs >= 12 eligible memories (`config.mjs:3200`). Accounts under 12 get an empty card, against the 10-19 "sparse records remain visible" ruling (`D-api-ui.md` defect 7). |
| V3 维度: two radars with fixed named axes, printed vertex numbers, ghost polygon, degenerate -> sentence | **BUILT** (+ bar fallback) | `radarOption.ts`; radar needs total >= 6 and >= 3 axes else bars. The 10-12 portrait review advised against radars (Albo 2016); the owner overruled on 10-12 evening. |
| V4 时间: four sub-charts (lineage lanes, event lanes, growth line, interest evolution by topic) | **DIFF** | Weekly bars + lineage/events in one chart; growth line removed 10-17; interest-over-time by topic not built (needed topic snapshots; portrait G12). |
| V5 活跃: calendar heat, click a day, no streaks | **BUILT** | `ActivityView.tsx`. |
| V6 drawer 关联 (backlinks) | **BUILT** | `RelatedSection.tsx`; use counts deliberately not shown (10-23 ruling "counts are bookkeeping"). |
| V7 knowledge-base tree/mind map/Sankey of a deliverable's inputs | **NOT** | Only a `tree` series for the source chain of one memory (`graphOption.ts:317`). The KB has its own graph tab; none of it is on the capsule landing (account-wide map never loads wiki/KG: `knowledgePageService.mjs:1052`). |
| V8 monthly/yearly review cards, one number + sentence + click-through, via the inbox | **NOT** | Portrait G11, "small trial first". |
| "需要看一眼" amber layer | **BUILT, THIN** | Only `source-*` and `expired` can occur: production has 0 conflicts (`C` D10), native has none, few memories rest on sources. |

### 2.3 Things the portrait review and the 09-19 proposal asked for

| Item | Status |
|---|---|
| G1 validity bar in drawer (`ValidityBar.tsx`) | BUILT (legacy only; native has `validFrom/invalidSince: null`) |
| G2 source conversation title in drawer | BUILT for legacy; **STARVED** for native (`conversations: {}`, `C` D3) |
| G13 project card | **DIFF**: six general slots, not PICO (10-12 owner ruling); built on the 项目 tab (`ProjectOverview.tsx`) |
| G9 capability distribution | **DIFF**: radar 「在做什么」 by task type + 「这个项目做过」 table |
| G10 works by month | BUILT on the 项目 tab |
| G8 研究领域 (specialties) | NOT (21-specialty closed vocabulary ruled against, 10-12) |
| G11 quarterly review, G12 topic snapshots | NOT |
| G21 "recently used in" backlink | BUILT in 关联 (no counts) |
| 09-19 §4.5 in-reply "本次用到的背景" panel | CUT (09-20/24, re-confirmed 10-12) |
| 09-19 §4.9 honest empty state for self-iteration (「已完成任务 12 · 你采纳 0…」) | NOT on the landing; 做法 tab has its own empty state |
| 09-19 §4.7 one-click whole-pack enable, trial once | BUILT (ReceivedShelf), unexercised in production |

### 2.4 Ten structural gaps, ranked (what actually produces "never got built")

1. **No capsule-level object on the landing.** No place shows 关于你 / 项目 / 我的做法 / 知识 / 收到的 / 成长 as six parts of one thing, with a number and a small mark each. Nothing replaced the 「EviMed 眼中的你」 overview when it was deleted except the memory-only headline.
2. **No day-one state.** 0-5 records give a thin state of three zeros (or, with documents, a document map under 「还没有记住什么」); the picture only starts to make sense at ~12+ memories (topics) and ~6 (radar).
3. **Growth is told by a memory-only chart, for native by almost nothing.** The thing the owner asked for first (V4) is the part with the least data on the engine the owner is on.
4. **The self-iteration third of the capsule is a single ▲ mark class** (<=40 approved methods, account scope only). Methods have no timeline, no "learned from N conversations" mark, no relation to the memories or documents they came from.
5. **The knowledge third is uploaded documents only,** and only as marks; compiled wiki/KG appear only after narrowing to one project.
6. **The sharing third has no picture** and, in production, no data and (by default) no UI switch.
7. **The graph encodes membership, not relation** (hub-and-spoke), so it looks like a diagram of nothing for typical accounts.
8. **Native accounts get a poorer map** (uniform marks, no lanes, no conflicts, no usage, no provenance), and the page does not say so or compensate.
9. **The landing hides the verbs** (no 记忆 switch, no 「⋯」, no 记住这一条, no 「刚记住了」) so the page reads as a viewer, not as a capsule one holds.
10. **Verification does not fail on emptiness** (one pressable row passes the walk), so "built" and "meaningful" diverged without a red test.

---

## 3. How mature products show user memory, personal knowledge and agent learning (2025-2026)

Method: web search and fetch on 2026-10-23, no personal identifier in any request. Evidence tags: **[P]** page or source read in full or in the relevant part today; **[S]** search-result summary only; **[L]** read in a local upstream checkout (OpenViking v0.5.1.1 source at `/tmp/ov-research/wt-v0.5.1.1`); **[R]** carried from the 10-12 EviMed research (`memory-capsule-research-20261012/01-visualization-patterns.md`), not re-verified today. Where today's check contradicted the earlier text it is said.

### 3.1 What the products do

| Product | What the user sees of memory | Chart forms | Lesson for EviMed |
|---|---|---|---|
| **ChatGPT** (Memory Summary, 2026-06 "Dreaming V3"; Memory Sources, 2026-05) | Settings > Personalization > Memory Summary: one auto-maintained, editable prose summary (edit by highlighting a passage or typing a change at the bottom); switching the new system off brings back the legacy saved-memories list; [P Thurrott, S release notes]; a Sources side panel under a personalised answer (2026-05) [R, not re-verified today] | none | The consumer leader moved to **prose you can correct in place**, not to charts. The summary is a partial view by OpenAI's own account [R]. A capsule picture must not pretend to be the whole. |
| **Claude** | Settings > Memory ("Tell Claude what to change or remove" box); legacy "View and edit your memory"; memory can be copied out and imported from another assistant as individual entries; work-focused [P support page] | none | Text-first, with **portability** (import/export) as the headline feature. Our share/import half is the same idea at a higher trust level. |
| **Gemini** (Personal Intelligence, 2026-01-14; Personal context for past chats) | A control surface of connected apps and a past-chats switch; no verified "what I know about you" page [S] | none | The control that matters to people is **which sources feed the memory**: that is a "知识 / 收到的" tile, not a graph. |
| **Mem0 / Memori** (developer platforms) | Memori dashboard: memories table (recall and mention counts, timestamps), a Subjects tab, a knowledge-graph view with time and semantic filters and trace-back from an entity to its source memories, KPI cards and an activity chart; the Playground shows an **"extracted memories" panel beside the chat** to confirm that extraction works [P mintlify.wiki Memori]. A search summary of Mem0's docs says only "dashboard to manage memory and key user insights"; fetching the overview page itself showed no dashboard description, so I could not confirm a graph view [S] | KPI cards, activity line, graph | Developer dashboards are KPI + table + graph. The part worth copying is the **live panel next to the conversation** that shows a memory appearing, which is where a person first believes in memory. Out of scope for the landing, and EviMed's own 「刚记住了 … 撤销」 toast already plays that role on the list tabs (not on the map). |
| **Zep / Graphiti** | Zep web app: Graph Explorer per user (entity nodes, labelled edges, a Node Details panel) [P Zep Q1-2025 post]; a **graph visualizer assistant** (chat panel beside the canvas, read-only, shows each retrieval step, selecting a step highlights its entities and facts on the canvas, entities not loaded sit under 「Not on canvas」) [P help.getzep.com]; edges carry valid-from / valid-to / learned-at / invalidated-at, but the visualizer page does not describe validity windows or filters [S, P] | node-link | Even Zep's own 2026 direction is to **drive the canvas with questions**, not to browse a hairball. Time-validity is in the model and not drawn: EviMed's lineage lanes are ahead here. |
| **Supermemory** | React Memory Graph component: documents are rectangles, memories hexagons, edges typed `updates` / `extends` / `derives`, canvas rendering, "hundreds of nodes" ok, paginate at 1,000+ documents, a console and a consumer variant, an **empty-state slot** and a legend component [P docs]. Consumer app: "visual graphs of your knowledge, interactions and memories" with an empty graph view and a legend [S, blog] | node-link, shapes by type | Edges **mean something** (a later fact replaces / refines / derives from another). EviMed's typical edge is "belongs to a project" and carries nothing. |
| **Letta ADE** | Context-window viewer (system instructions, tools, core memory blocks, archival stats, summary) and editable, **shareable** core memory blocks [P docs, S] | stacked context bar (conceptually) | The honest picture is "what is in the context right now"; blocks shared between agents are the closest peer to our capsule share. A developer tool, not for the end user. |
| **OpenViking Web Studio** (our own engine, v0.5.1.1) | `/memories` is a redirect to the **file browser** at `viking://user/<id>/memories/`; an `agent-experience` page lists experiences with an **outcome distribution**, a trajectory list and preview, a source-trace panel and a time-range picker; there are `compile`, `monitoring`, `tasks` pages [L: `web-studio/src/routes/memories.tsx`, `agent-experience/-components/*`] | tree, table, distribution bar | The native engine's own viewer for memory is a directory of files, with no chart. For learned experience it uses a **distribution + a list of trajectories + a source trace**. Nothing upstream gives us a capsule picture to adopt; we draw ours. |
| **Obsidian / Logseq / Roam** | Global graph: criticised for position reset on every load, crowded unreadable overlaps even at depth 2, "pretty but useless"; defended for the **local graph**; no independent evidence that graph views improve PKM [S forum, S]. Obsidian shipped **Bases** (core plugin, v1.9, 2025-05): table / list / cards over notes' properties [S, from the help page and 1.9.0 changelog in the results] | graph vs table/cards | Even the graph's home turf added **table and card views over the same notes**. The local graph is the useful one. |
| **Limitless / Rewind** | Meta acquired Limitless 2025-12-05; Rewind's Mac capture ended 2025-12-19; pendant sales stopped [S 9to5mac etc.] | timeline of cards | The record-everything lifelog did not survive; the pattern worth keeping is "ask, with links to the source" [R]. |
| **Granola** | Your words black, AI's grey, a magnifier on each AI line to see its source [R] | colour by author | Cheap way to carry "yours vs the platform's" without a label, though EviMed's 10-10 ruling forbids back-office provenance on screen. |
| **Notion** | Per-agent memory and custom instructions; no verified memory viewer [S] | none | Memory as a document the person can open and edit. |
| **Spotify Wrapped / Strava Year in Sport** | Wrapped 2025: story cards from the year's listening, share cards, playback controls [S Spotify newsroom]. Strava: a report is generated only with **at least 3 activities** in the year, plus an active subscription [S Strava help in several languages] | story cards | Review products **state their minimum** and then give one number and one sentence per card. A threshold is acceptable when it is explicit. |
| **WHOOP** | Some insights appear at once; a baseline needs a calibration period (official: 30 days) [S whoop.com] | trend vs baseline | Show what you can **immediately**, mark the rest as calibrating. |
| **HCI evidence** | 121-user speed-dating study: users favoured proactive controls over cognitively demanding causal-graph inspection or passive audit logs; the central tension is oversight versus interaction overhead [P arXiv 2609.33623 abstract; the "37.6% inappropriate" figure the 10-12 text cites is **not in the abstract** and I could not confirm it today]. 18-user study: wanted review, edit, delete, categorise and clarity on how inferred information is used [S arXiv 2508.07664]. MemoAnalyzer: visualises private information in memories with colour temperature and transparency mapped to confidence and sensitivity; 36 participants over five days gained privacy awareness [S arXiv 2410.14931] | colour-encoded list | Nobody has shown that a memory graph helps an end user. What is evidenced is **editable lists, light proactive control, and highlighting what needs attention**. |

### 3.2 What works with sparse data

1. **Show the things, not a summary of them, when there are few (Weissgerber et al. 2015, PLoS Biology; ANU companion guide).** For small n, show every data point (strip or dot plot), do not draw bars or error bars that imply a distribution [P]. For a capsule, the equivalent is one row or one dot per memory with its words, not a bar of "3".
2. **Different forms at different sizes.** Node-link diagrams read well for small sparse graphs; legibility drops steeply from about 50 nodes; adjacency matrices win above about 20 vertices on most tasks (Ghoniem, Fekete, Castagliola; replicated by Keller et al. and a 600-person study) [S]. A capsule has hubs and few relations, so the sensible forms are: **list or dots (up to ~6), ranked bars (~7-30), folded clusters or matrix (30+)**. The same data should change form as it grows; today the graph is the same form from 3 to 200.
3. **Explicit minimums, stated once, with something shown meanwhile.** Strava states 3 activities; WHOOP shows instant metrics and labels the calibration. Nielsen Norman's three jobs of an empty state: status, what belongs here, a direct next action; and first-use is not the same as "cleared" [S, secondary]. EviMed's own rule matches (an empty state is a recipe).
4. **One number plus one sentence per card, each number a link** (Wrapped's grammar, EviMed's `Headline` and `Note` rules).
5. **Questions drive the canvas** (Zep's assistant): from a mark, "就这个提问" is a better exploration tool than a bigger graph.

### 3.3 What fails

1. **The global hairball graph** (Obsidian threads; node-link above ~50 nodes; edges that are only membership). Fix by clusters, a local focus, typed edges, or not drawing edges at all.
2. **Radars with arbitrary axes** (axis order changes the enclosed area, e.g. 19% versus 2% on the same stats; the line between two categorical axes means nothing; precise values are hard to read) [S]. They hold up with 5-10 same-unit variables when the shape is the point. EviMed's radars have fixed named axes and printed numbers, which is the defensible case, but at small counts they are needles: the code already falls back to bars below 6 items or 3 axes.
3. **Activity logs and KPI dashboards as the user's face** (the 121-user study ranked the memory activity timeline second-to-last; "monitoring panel" feel) [R, P abstract for the preference direction]. Counts of operations are for the operator.
4. **Developer graph explorers handed to consumers** (Zep, Supermemory console, Memori): their own docs call them developer tools.
5. **Streaks and badges** (GitHub's own removal; Moldon et al.) [R].
6. **A partial picture presented as the whole** (ChatGPT's summary is narrower than what is stored [R]; EviMed's map leaves out capsule notes, packs and compiled knowledge, and says nothing).

### 3.4 Rules this gives the redesign

- Lead with **parts and a growth story**, not a graph. Graph stays as the drill-down view.
- Every part card has a **recipe state** (what it uses, what it gives, one button) and a **list-first small-sample state**.
- Form changes with size at thresholds that are **plain numbers in code** (0, 1-5, 6-30, 31+; dots below ~30 events).
- Colour only blue / amber / grey; shapes carry kind (reuse `MarkGlyph`).
- Partial reads: **per-card** loading, error and content states; a failed card is named, never drawn as 0.
- Nothing about who wrote a memory or how sure the platform is.

---

## 4. Redesign proposal: a 记忆胶囊 landing that is a capsule from day one

### 4.1 Decision in one paragraph

Keep the five-view map exactly as the owner ruled (it is the explorer), and put in front of it a **capsule overview**: one page of **six same-grammar part cards** (关于你 · 项目 · 我的做法 · 知识 · 收到的 · 成长), one sentence over them whose numbers are links, and one short list of what needs a look. Each card is a number, a mark that **changes form with the amount of data** (list, then dots or ranked bars, then folded clusters), and one action. `/app/memory` lands on it. Every mark on it opens the same drawer as on the map and the lists; every card drills into the map narrowed to that part. It must be useful with **zero memories** (the owner's native account): half the cards are populated from the knowledge base, the projects and the conversations, and the rest are recipes with one button.

Recommended placement: a new first tab **总览** of `MemoryFrame` (tabs become 总览 · 地图 · 关于你 · 项目 · 做法), route `/app/memory/overview`, template T4 with its own budget row in `scripts/ops/page-templates.json`. Fallback if the owner wants one page only: make the cards the unnarrowed state of `/app/memory/map` and raise that page's `shapes` from 3 to 4 (needs a `DESIGN.md` rule 1 edit, owner's call). I recommend the tab: the map's measured budget is already "at the budget" (9 control kinds, 10 with the tabs, `DESIGN.md` rule 1), and the walk's `memory-map` entry must keep meaning "the explorer".

### 4.2 The page

Slots (`PageShell`, in the framework's order): `scope` = the existing project `ScopeMenu` (全部项目 default; every card honours it); `tabs` = `MemoryFrame`; `actions` = the 记忆 switch and 「⋯」 (分享与导入 · 已忘记的内容 · 本项目不使用记忆 · 重置记忆) — this also repairs `D-api-ui.md` defect 3 on the map; `toolbar` = none (no range control: the growth card has its own axis); `headline` = one sentence.

Headline grammar (each number a link to its part; numbers come only from reads that succeeded):

- populated: 「胶囊里有 12 件关于你和项目的事、3 种做法、47 份资料；这个月新增 5 件。」
- documents only (the owner's probable case): 「胶囊里有 47 份资料，还没有记下关于你的事。」 (today the map says 「还没有记住什么」 over a document graph)
- nothing: a `Note` with the action 「去对话」.
- a card failed to read: that card says so (`LoadError`), the sentence leaves its number out; **a failed read is never a zero**.

Body: one `ChartGrid` (2 columns, rows full), then one list.

```
记忆胶囊                                   [项目：全部 ▾]            [记忆 ●]  [⋯]
 总览 │ 地图 │ 关于你 │ 项目 │ 做法
 胶囊里有 12 件关于你和项目的事、3 种做法、47 份资料；这个月新增 5 件。
┌ 自 9 月 22 日起，记下 18 件、学会 3 种做法、放进 47 份资料 ─────── 成长 ┐  span 2
│ 记下 ●  ·   ● ●  ●●   ●   ●●●  ●      ●                                │  dots if <=30 events,
│ 学会 ▲           ▲          ▲                                           │  else weekly bars
│ 资料 ■  ■■■■  ■■   ■■■■■■■   ■■■                                        │  (a lane exists only when
│        9月22日 ───────────────────────────────────────────── 今天        │   it has events)
├───────────────────────────────┬──────────────────────────────────────┤
│ 关于你 · 6 件                 │ 项目 · 3 个                           │
│ ● 偏好  中文、结论先行          │ 阿司匹林一级预防   记忆 5 · 资料 22   │
│ ● 背景  临床药师，做心血管…     │ 房颤抗凝           记忆 4 · 资料 17   │
│ ◆ 纠正  报告不要英文摘要        │ 其他               记忆 3 · 资料  8   │
│ …                  在地图里看 › │                          在地图里看 › │
├───────────────────────────────┼──────────────────────────────────────┤
│ 我的做法 · 3 种               │ 知识 · 47 份资料                       │
│ ▲ 证据矩阵先行      9 月 24 日  │ 文献 ▇▇▇▇▇▇▇ 31   文档 ▇▇ 9   表格 ▇ 7│
│ ▲ …                            │ 3 条记忆依据的资料变了 (amber, link)    │
│                    在地图里看 › │                          在地图里看 › │
├───────────────────────────────┴──────────────────────────────────────┤
│ 收到的 · 1 个，发出的 0 个    我能交出去的：方法 3 · 标准与偏好 5 · 背景 12 │  span 2
│ 李主任的工作方式 v3   [启用 ○]                          分享与导入 ›     │
└──────────────────────────────────────────────────────────────────────┘
 需要看一眼 · 3                                                             list: amber rows first,
 ● 偏好 …… 依据的资料有更新                                                   then the latest changes;
 ● 决定 …… 和另一条说法不一致                                                 every row opens a drawer
```

The grid puts 成长 first because it is the promise of the original vision (V4); the table below follows the owner's own order of the six parts.

For the owner's probable account (illustrative, not measured: projects and documents present, no memory files, no methods, nothing received), the same page reads:

```
 胶囊里有 47 份资料，还没有记下关于你的事。
 成长: ■ lane only (documents by week)          ← real, from the knowledge base
 关于你: recipe  [记住这一条]                    ← writes through the engine; the first mark appears at once and can be edited or forgotten from its drawer
 项目: 3 rows with 资料 counts
 我的做法: recipe  用：你交付的文件和纠正  给：下次自动带上的做法  [去做一件事]
 知识: composition bars
 收到的: recipe  [导入一个胶囊]
```

### 4.3 The six cards: which mark for which amount

Thresholds are plain constants in one module (`memoryOverviewModel.ts`, pure functions, unit-tested at 0 / 1 / 5 / 6 / 30 / 31). Reasoning: Weissgerber (show the points when few), Ghoniem (form must change with size; ~20 and ~50 are where node-link stops being readable), Strava/WHOOP (state the minimum, show something immediately).

| Part (owner's order) | 0 | 1 to 5 | 6 to 30 | 31 and more | Click |
|---|---|---|---|---|---|
| **关于你** (user-scope memories) | recipe: 「记住这一条」 (native; writes a file through `POST /api/memory/remember`) or 「去对话」 (legacy) | the statements themselves as rows: kind glyph, 36 characters, date; the list is the picture | **ranked horizontal bars by the four personal aspects** (背景 / 偏好 / 习惯 / 纠正; 项目事实 and 决策 count under 项目), a tick for "30 days ago"; each bar narrows the map; **never a radar here** (the radar stays in 维度) | the same bars plus the three newest statements | row = drawer; card = 地图 narrowed to 关于你 |
| **项目** | recipe 「新建项目」 (rare) | one project: its card slots as a `FactList` (`GET /api/memory/projects/:id/overview`, six general slots, existing) | `DataTable` with an `InlineBar` per project: 记忆 · 资料 · need-a-look | top 8 by recent activity + 「全部 N 个」 | row = the 项目 tab on that project |
| **我的做法** (learned methods) | recipe: uses "你交付的文件和纠正", gives "下次自动带上的做法", button 「去做一件事」 | method rows: ▲, title, date learned; opens `MethodDrawer` | ▲ dots on a month axis, newest three as rows; no usage counts on screen (09-23 ruling) | monthly bars, newest three | row = drawer; card = 做法 tab |
| **知识** | recipe 「上传一份资料」 (to `/app/files`) | document rows with type word | composition: `InlineBar` rows by document type, at most 5, the rest folded into 其他 | same | row = the document's own page; the amber 「N 条记忆依据的资料变了」 narrows the map (`look=1`) |
| **收到的** | recipe 「导入一个胶囊」 (opens 分享与导入 > 导入) | received packs as rows with the 启用 switch (existing `ReceivedShelf` data); the **工作方式卡** of my own exportable capsule beside it: one stacked bar 方法 · 标准与偏好 · 背景 (three named categories only) from `previewCapsuleExport` | same | same | row = the received pack's page; card = 分享与导入 |
| **成长** (the V4 timeline) | `ChartCard state="empty"` with 「去对话」 | **one dot per event**, lanes 记下 ● / 学会 ▲ / 资料 ■ (a lane only if it has events), x = date since the first event, axis in days under 14 days else weeks | dots up to 30 events in total, then **weekly counts per lane** | weekly counts per lane (same `weekOption` family as the time view) | dot = drawer or page; card = 地图 time view |

Notes on the form of 成长: it counts what the capsule **gains** (a memory noted, a method learned, a document added, a pack received), because that is what the owner asked to see grow and what a person can be glad of. What was replaced or forgotten stays in the map's 时间 view, whose bars are unchanged. For a native account "replaced" cannot exist anyway. The title is a sentence with numbers in the grammar of `weeksSentence` (「自 9 月 22 日起，记下 18 件、学会 3 种做法、放进 47 份资料」); no streak, no "active days", no badge.

The sharing half's face is the **工作方式卡**: the small stacked bar and its three named categories, 「含 / 不含」 in plain words (the build spec A5 and the Apple privacy-label research the 10-12 text cites). The same component renders on `SharedCapsulePage`, so a person who receives a pack sees **how the sender works** in the same grammar as their own. This is the part of the original vision (V5) that has no picture today.

### 4.4 Both engines

| Card | Legacy (PostgreSQL) | Native (OpenViking files) | What the page does about the difference |
|---|---|---|---|
| 关于你 / 项目 | records with kinds, projects | files mapped to the same six kinds; every file `importance 0.5` | identical form; **no mark is sized by importance or usage** on the overview (native has none), so legacy and native read the same |
| 我的做法, 收到的, 知识 | engine-independent | engine-independent | identical |
| 成长 | memory events incl. supersede; methods; documents | memory events from overlay revisions (no supersede), methods, documents | the growth card counts gains only, which both engines have; replacement stays in 时间 |
| need-a-look list | `source-*`, `conflict`, `expired` | only `source-*` (overlay labels), no conflicts | the list simply has fewer rows |
| provenance (conversation a memory came from) | `conversations` | `{}` (`C-memory-engines.md` D3) | not drawn on the overview; the drawer keeps its own line |

Dependency to settle first: **capsule notes (项目笔记)** are capsule facts, unreachable from a native account's conversations (`C` D1). Do not count them as "remembered" for a native account on this page until that is decided; otherwise the card would show things the conversation cannot use.

### 4.5 Data each card needs: existing versus new

| Need | Existing | New |
|---|---|---|
| Headline numbers, 关于你, 项目, need-a-look list | `GET /api/memory/map?include=summary,facets,nodes` (`facets.projects`, memory nodes with `projectId`, cluster counts, `summary.needsLook`) | none |
| 成长 | `include=buckets,events` (memory and method events, 365-day counts), `GET /api/memory/learned` (days a method was learned, unused today) | `buckets.series[].document` (documents added per day; the documents source already lists up to 100 per project, so counted per day, capped there) and, after D1, capsule-note events |
| 我的做法 | `listAllMethods("approved")` or the map's ▲ nodes | none |
| 知识 composition | map nodes of type `document` with `group` (type word), `summary.documents` | `facets.documentTypes` (counts by type word, not capped at 100) |
| 收到的 and 工作方式卡 | `fetchReceivedCapsules`, `fetchMyCapsule`, `previewCapsuleExport`, `listCapsuleExports` | none; each is its own read with its own state |
| Drill-down | selection params | a client-side `part` narrowing (`you` / `project` / `method` / `knowledge`) in `narrowMap`, the way `kind` already narrows; `MapDrawer` learns `entry:` keys (capsule notes open `FactDrawer` on the memory page already) |

Every card reads independently and has loading, error-with-retry and content states (`DESIGN.md` four states); the headline composes only from cards that read. The page needs **no new engine call and no new write**.

### 4.6 How it satisfies the rulings and the framework (checklist)

| Rule | Status |
|---|---|
| Memory visualization is the landing view; five views over one selection; every mark opens the record's own drawer | landing is 总览, which links into the five-view map; marks open `FactDrawer` / `MethodDrawer` / the document page |
| Sparse real records remain visible; charts suited to small samples | list and dots below 6 / 30; no radar, no topic cloud below 12 on the landing |
| Partial read errors never become zeros | per-card error, headline drops the number |
| Editable lists, sharing, engine boundaries preserved | nothing removed; header actions restored on map and overview |
| No back-office provenance | none drawn: no origin, basis, confidence, engine name, usage count |
| Page framework: slots, one toolbar row, no filler, a sentence carries an action or a number | slots as in 4.2; no toolbar; card titles are sentences with numbers; empty states are recipes |
| Data-page budget: five type pairs, ten control kinds, seven text colours, metric rung 32 | **to be measured, not assumed**: headline, card title, metric 32/600, body 14/400, caption 12/400 is five pairs; cards' actions use one control kind (the title link, like `StatTile to`); one canvas (the growth strip) and everything else in DOM; colours from `mapPalette()` (blue, amber, grey) only |
| Tokens and Chinese UI | no new token, no hex, no new colour; glyphs from `MarkGlyph` |

Risks to flag: (a) the walk may count the card links as a new control kind: measure on the overview with `scripts/ops/ui-walk.mjs` before shipping, and if it overshoots, make the whole card a single `ListRow`-style target; (b) 5 type pairs is the ceiling, so no sixth size (no 40 px lead tile); (c) this page is a new template row and a new acceptance entry, which the owner's 10-14 rule on measured composition requires anyway.

### 4.7 Order of work (my estimates, for sequencing only)

| Step | What | Depends on | Size |
|---|---|---|---|
| 0 | Repair the landing without redesign: header actions on the map page (the 记忆 switch and 「⋯」), the headline when memories are 0 but documents exist, the thin state naming real parts; a walk assertion that the headline's numbers equal the list's rows ("walk assertions must prove they walked") | none | 0.5-1 d |
| 1 | `memoryOverviewModel.ts` (pure: thresholds, aspect bars, growth lanes, headline) + overview shell + **成长 card** + per-card states + walk entry + `page-templates.json` row + `pageComposition` test | existing `events` / `buckets`; `buckets.series[].document` (+0.5 d server) | ~3 d |
| 2 | 关于你, 项目, 知识 cards | step 1; `facets.documentTypes` (+0.5 d server) | ~2 d |
| 3 | 我的做法 and 收到的 cards, the 工作方式卡, reuse on `SharedCapsulePage` | step 1 | ~2 d |
| 4 | `part` selection and drill-down both ways; `/app/memory` lands on 总览; `MapDrawer` opens `entry:` | steps 1-3 | ~1.5 d |
| 5 | Capsule notes into the map and the growth card, `/api/memory/learned` moments | decision on `C` D1 (capsule facts for native) | ~2-3 d |
| 6 | Later: deterministic grouping when fewer than 12 memories (so 主题 has a day-one), recency-sized marks for native, conversation provenance for native (`C` D3), a 「就这个提问」 action on a card (opens a new conversation with the question drafted; no input in a drawer) | the above | separate |

What the redesign cannot do: create memories. The owner's account has none because of the engine and runtime causes in `C-memory-engines.md` (D2 stale launch value, D5 conservative templates and attended-turn-only commit). The overview makes that emptiness legible and gives it one action (「记住这一条」 writes a file through the engine at once, and the drawer can edit or forget it), and it makes the other parts of the capsule visible independently of memory files.

### 4.8 What not to build

A global force graph on the landing; any score, "了解度", personality or archetype label; streaks and badges; a radar on the landing; an activity-log timeline as the face; per-answer "memories used" panels (ruled out 09-20, 09-24, 10-12); usage counts on screen; a second grouped graph for the knowledge base inside this page (the KB has its own); anything that says who wrote a memory.

### 4.9 Questions for the owner

1. New 总览 tab (recommended) or the cards as the map's unnarrowed state (needs `DESIGN.md` rule 1 changed from three shapes to four)?
2. 成长 counts gains only (记下 · 学会 · 资料 · 收下) and leaves 合并 and 忘记 to the 时间 view: agreed?
3. For native accounts, may capsule notes count as "remembered" before `C` D1 is settled? (Recommendation: no.)
4. The 工作方式卡 on a received pack (how the sender works, three named categories): wanted on `SharedCapsulePage` too, or only in the owner's own overview?

### 4.10 Verified-versus-inferred summary for the coordinator

VERIFIED in code: five views, their data sources and thresholds (topics at 12, radars at 6 items and 3 axes), the plain-entry redirect to the map, the absence of header actions on the map, the absence of capsule notes, packs and compiled knowledge from the account-wide map, native records' constant importance and empty usage, the unused growth and learned routes, the unexercised sharing path, the walk's one-row pass. INFERRED: what the owner's page looks like (no production data read), the budget measurements for the new page, the size estimates. Not available: the spec's figures (the `2026-09-21-memory-capsule-assets` directory is not in the tree).
