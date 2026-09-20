# C — The memory capsule module: tabs, data model, search, learning loop (read-only code audit, 2026-09-20)

Produced by a read-only sub-investigation for `../2026-09-20-产品现状根因分析与一次性整改方案.md`. File and line references are as of commit 70683e97a.

## A. The six tabs

| Tab | Component | Shows | Feed | Asks of the user | Empty text |
|---|---|---|---|---|---|
| 总览 | `capsule/CapsuleOverview.tsx:43` | ≤12 stored sentences as prose + 4 count tiles + 「还缺」 list + memory switches | `GET /api/memory/profile` (`evimed_memory.records`), `fetchMyCapsule` (`evimed_product.documents` capsule/fact), `GET /api/methods`, `GET /api/library` (:46-52) | 「改一句」「不要再提这条」 per sentence (:141,143); 「去看看」 (:182); 3 switches + 「重置全部记忆」 (`memory/MemoryControls.tsx:116,128`) | "EviMed 还不了解你。和它多聊几次…" (:115) |
| 对你的理解 | `capsule/UnderstandingSection.tsx:41` + `MemoryPage embedded` | 4 topic lists (profile/preference/behavior/correction) + capsule entries (preference/writing_style/expertise) + 「你写下的笔记」 | same `/api/memory/profile`, filtered `scope==="user"` and `kind ∉ PROJECT_KINDS` (:50-51,31) | source filter (:77); per-row edit/archive (`MemoryRecordRow`); **the note composer**: textarea + 「保存记忆」 (`MemoryPage.tsx:198-209`), pin/edit/archive/delete (:256-278), search box (:225) | `RECORD_TOPICS` empties (:17-20); "还没有科研记忆…不必把临时对话全部保存" (`MemoryPage.tsx:241-242`) |
| 项目档案 | `capsule/ProjectDossierSection.tsx:36` | project_fact / analysis / decision / follow_up + task-written project notes + 「曾经如此」 (superseded) | **same table**, filtered by `PROJECT_KINDS` (:22,45-51) | none but row edits | per topic (:16-19) |
| 方法 | `capsule/CapsuleMethodsSection.tsx:25` | 你写下的方法 · 学到的方法 · 收到的胶囊 · 分享 · 逐个管理胶囊 | `fetchMyCapsule` facts `factKind==="method_preference"` (:14,40); `MethodsPage` → `/api/methods`; `ReceivedShelf` → `/api/capsules` | **two different 「写一个方法」 forms**: free text → capsule entry (:71-85) and SKILL.md → method doc (`MethodsPage.tsx:163-181`); 停用/回到上一版 (:245-251); 试用一次/启用/停用 (`ReceivedShelf.tsx:131-134`); folded `CapsulesPage` still offers 新建胶囊, 条目类型 dropdown, 新增条目, 采用/停用/修订, 用于当前项目 + 主要/参考 dropdown, 回收站 (`CapsulesPage.tsx:124,131,157-172,201-202`) | "还没有写下方法。写一条你常用的做法…" (:68); "还没有学到的方法" (`MethodsPage.tsx:193-196`) |
| 资料 | `capsule/LibrarySection.tsx:32` | personal-library rows: title, kind, authors, DOI, pages, status, addedAt | `GET /api/library` (`libraryService.mjs:716`) | 本项目/全部 toggle (:70); **「放进胶囊」 per document** (:96-105) → `POST /api/library/:id/publish-to-capsule` | "这个项目还没有资料。/资料库是空的。在 知识库 上传…" (:78) |
| 时间轴 | `capsule/CapsuleTimeline.tsx:93` | year density band + event list | `GET /api/memory/timeline`, derived at read time from record revisions, run ledger, methods, feedback (`memoryTimeline.mjs:1-17`) | month select (:181), 加载更早的 (:213) | "还没有任何变化。和 EviMed 做几次任务，这里就会有记录。" (:188) |

**Work the system could do itself:** every 「还缺」 line instructs the user to author data (`CapsuleOverview.tsx:73-77`: say 「我是…」, write a method, write your writing style, upload works); the note composer (`MemoryPage.tsx:198`) is a hand-written duplicate of what the extractor already writes; both 「写一个方法」 forms; 「放进胶囊」 per document (the library already has the understanding — `publishToCapsule` only copies rows); `CapsulesPage`'s 新建胶囊 / 条目类型 / 采用 / 用于当前项目, which the hub's own comment calls "一般不需要" (`CapsuleMethodsSection.tsx:98`).

## B. Data model

| Store | Table | Written by | Read at run time | Scope |
|---|---|---|---|---|
| memory records | `evimed_memory.records` (`researchMemoryPersistence.mjs:69`; kinds :25-28; scopes :24) | extractor (`memoryIntelligence.mjs`), user edits | recall injection + `evimed_capsule_recall` via `recallAcrossMemory` (`memoryRecall.mjs:70`) | `user`/`project`/`session` column |
| notes | `evimed_memory.notes` (:106), `search_vector` :123 | **user only** | same recall, `memoryType:"manual"` | account |
| settings / session | `.settings` (:127), `.sessions` (:139) | user | `memoryPausedFor` | account / conversation |
| capsule + entries | `evimed_product.documents` kind `capsule`,`fact` (`productPersistence.mjs:4,50`); `CAPSULE_FACT_KINDS` (`domain/capsule.mjs:40`), layers (:30) | user forms, runtime `capsule_note`, library publish | `capsuleService.recall` (:553); mounted as skills if `factKind ∈ CAPSULE_WORK_STYLE_FACT_KINDS` and `layer ≠ sources` (`capsuleMethods.mjs:43-48,73`) | account, activated per project |
| learned + written methods | kind `method`; trials kind `method-trial` (:11) | learning loop; `POST /api/methods` sets `origin:"explicit"` (`learningRoutes.mjs:162`) | `selectLearnedMethods` mount | account/project |
| received capsules | same `capsule` kind, `payload.imported` (`ReceivedShelf.tsx:19`) | import | whole-pack enable | account |
| 「资料」 | kind `preferences`, `recordType:"library-item"` (`libraryService.mjs:41-42`) + Markdown copy mounted read-only at `/workspace/library` (:21-23) | user bookmarks a source (`SourcesPage.tsx:501` 「加入资料库」) | `kb_search` | **account** |
| 知识库 sources | kinds `source`,`source-unit` | upload / OpenList sync (`sourceService.mjs`) | `kb_search` | **project** |
| kb index | `evimed_kb.documents`/`chunks` (`kbPersistence.mjs:33,46`) — derived, rebuildable | indexer | `kb_search` only | account |
| run summaries | records `kind:"run_summary"` (`memoryIntelligence.mjs:1059`) | extractor | excluded from recall and from every tab | project |

**Overlaps.** (1) `MEMORY_KINDS` and `CAPSULE_FACT_KINDS` share eight identical names — profile, preference, behavior, project_fact, analysis, decision, correction, follow_up — in two tables, and both are recalled by one call (`memoryRecall.mjs:66-73`). (2) Three user-writable stores of "what to know about me": notes, records, capsule entries. (3) Two stores of "a method I wrote": capsule `method_preference` and method doc `origin:explicit`. (4) 「资料」 is **not** a second document store: it is an account-level bookmark over the project's 知识库 sources plus a copy on disk; 项目档案 holds no documents at all, only memory records of project kinds.

## C. Search

UI: exactly one box — `MemoryPage.tsx:225`, client-side `toLowerCase().includes` over the already-loaded notes' content and tags (:114-120). 总览/项目档案/方法/资料/时间轴 have no search. Run time: `memorySubstrate.recall` (`memorySubstrate.mjs:194`) → OpenViking `find` + hydrate + rerank when the provider resolves to `openviking`, else `researchMemory.relevant` — token-substring scoring with CJK bigrams (`researchMemory.mjs:1421+`, `memoryRecallPolicy.mjs:144-156`); provider defaults to `builtin` unless an OpenViking URL+key exist (`memorySubstrate.mjs:62-70`). Durable kinds get a 50% reserved budget (`memoryRecallPolicy.mjs:19,41`). Capsule side is semantic-then-lexical (`capsuleService.mjs:553-598`). Tools: `evimed_capsule_recall`/`evimed_capsule_note` (`socket/plugins/capsule.mjs:79`), MCP `memory_recall`/`memory_note` (`runtime/mcp/evimed-memory/server.py:42,64`), `kb_search` (`runtime/mcp/evimed-research/kb_search.py:46`).

## D. Learning loop

Triggers, no clicks: `delivered` / `repair_accepted` / `correction` / `routine` (every 3rd successful run of one capability) — `learningTriggers.mjs:63-134`; skipped for paused, incognito, trial (:161-173). Window `22:00-09:00` `Asia/Shanghai` (`config.mjs:1305,1317`), enabled by default (:1295), concurrency 2, ¥5/20/1 caps. Promotion needs ≥3 trajectories, ≥2 runs, and a passing paired evaluation whose candidate and baseline digests both match (`methodGraph.mjs:458-548`); explicit-origin methods bypass all of it (:521-524).

**The blocker:** `learningEvaluationCommand` defaults to `""` (`config.mjs:1338`), so `server.mjs:1933` passes `evaluate: null` and `methodConsolidation.mjs:348` throws `method_evaluation_unavailable`. Under stock defaults no distilled method can ever leave `candidate`. `deploy/web/.env.example:304` does set one; `learningEvaluationUsers` has no `.env.example` line at all, so trial mounts 403 (`config.mjs:1349`). The proposal recorded `evimed_product.documents` at **0 rows** in production (doc line 45), and the old triggers could not fire under defaults (`learningTriggers.mjs:4-11`).

## E. Session controls

`GET/PUT /api/memory/sessions/:id` — PUT accepts only `{incognito}` (`memorySessions.mjs:292-301`); `POST/DELETE .../exclusions` (:303-313); `GET .../background` (:315). UI: `SessionMemoryBar.tsx:76-124`, `SessionBackgroundPanel.tsx`. Write prompt: `useMemoryWritePrompt.ts:39-55` → `/api/memory/changes?since` → undo. Incognito depth for removal planning: column (`researchMemoryPersistence.mjs:143`), `memoryPausedFor` folding it into both learning and recall (`researchMemory.mjs:451-469`), `memorySubstrate.mjs:201`, `memoryIntelligence.mjs:650,723`, `capsuleGateway.mjs:66-113`, `learningTriggers.mjs:169`, `agentRuns.mjs:3838`, `accountExport.mjs:89`, plus the two routes and two components — ~10 sites.

## F. Minimum coherent model

**One thing:** *the capsule is what EviMed knows and how it works; 知识库 is your files.* Merge `evimed_memory.records`, `notes` and capsule `fact` entries into one record store with one kind vocabulary — today they are three tables holding the same eight kinds and three user-facing composers for one intent.

**The user should see three surfaces, not six tabs:** (1) **对你的理解** — the prose portrait plus its sentences, each editable/droppable, including what is now 项目档案 as a scope filter 「跟着我 / 仅本项目」 (it is the same table, split only by `kind`); (2) **方法** — one list with origin badges (你写的 / 学到的 / 来自资料 / 来自 A 的胶囊) plus the received shelf; (3) **时间轴**. 资料 becomes a read-only line inside 对你的理解 — "从你的 N 份资料读到的" — linking to 知识库.

**What should disappear:** both 「写一个方法」 forms (a method is learned from a correction or a repeat; if a user types one it should be typed *in the conversation* and extracted); the 「你写下的笔记」 composer and the whole `evimed_memory.notes` table; 「放进胶囊」 per document (publish automatically when a source's understanding completes, labelled 来自资料, reversible); the 总览 count tiles and 「还缺」 chore list; the folded `CapsulesPage` in its entirety — 新建胶囊, 条目类型 dropdown, 采用/停用 per entry, 用于当前项目 mode dropdown, 回收站; 「逐个管理胶囊」; 无痕 (session controls duplicate the recall switch and cost ~10 server call sites).

**What must be fixed for the story to be true:** ship `OPEN_SCIENCE_LEARNING_EVALUATION_COMMAND` or promote on observation alone — a 方法 tab that can never approve anything is why "learned over time" reads as fiction.
