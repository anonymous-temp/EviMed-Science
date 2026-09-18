# Live findings (main session, 2026-09-18) — evidence gathered on production, read-only

Release `evimed-3dc0fa10cd25-1`, account `cdss-access`, kernel client 0.1.5-rc.2. Screenshots: `docs/ui-ux-audit/2026-09-18-walk/`.

## Done
- 18 test projects archived (`.evimed-local/acceptance/archive/cdss-access-test-projects-2026-09-17.tgz`, 99 MB) and deleted via `DELETE /api/projects/:id`. Remaining: `default`, `eval-memory-ablation-v11-9def6619` (most complete: 62 KB report, 72 claims of all three types, matrix + revision-notes + agenda-delta, clean workspace, judge 4/4/4/5). Inbox unread went 31 → 2 (notifications cascade with project deletion).
- No rename route exists (`server.mjs:3032-3081` has GET/POST/DELETE/export only); POST accepts `name` ≤128 but `ProjectSwitcher.tsx` sends only an ASCII id. "Default Project" is hard-coded in `store.mjs:571` and `store.mjs:1035`.

## F1 「深度求索中...」
Kernel locale namespace `chat`, key `chat.deepDiving` (`/tmp/dshc/.../dsh-client-ui-chat/lib/client.js`, zh dict). Override through `EVIMED_DICTIONARIES` in `packages/harness-port/src/runtimeUiShell.mjs` (both the exported table and the inlined copy in `apply`).

## F2 Right sidebar blank
`HOSTED_DISABLED_BROWSER_PANELS` (`apps/server/src/dshProfilePatch.mjs:302`) disables `ui-sidebar-files`, `ui-sidebar-documentpreview`, `ui-goal`, …; `OPERATOR_ONLY_BROWSER_PANELS` = `ui-trajectory` (commit 0935c32c7, 2026-09-16). What is left in the right pane is the kernel's empty 「开始」 start tab; 「新标签页」 opens nothing because no tab type is registered. Header controls present: 新标签页 / 分栏 / 全屏 / 收起右侧边栏.
Measured grid with the panel open (our CSS pins `_centerCol{grid-column:1/3}`, `_rightbarCol{grid-column:3}`):
- viewport 1440 → frame 1208: grid `280px 400px 528px`, centre 680, right 528, composer 634 wide
- viewport 1280 → right 368, centre 680
- viewport 1728 → centre 823, right 673
Screenshot `14-chat-right-panel.png` shows the conversation clipped on the left during/after opening at 1440 (content wider than the 680 px column, overflow hidden) — verify whether transient.

## F3 "Per-step execution progress"
= kernel `ui-trajectory` (event ledger + timing overview), operator-only since 2026-09-16 because it shows system prompts / raw JSON. Native alternatives present in the client and NOT disabled: `ui-jobs`, `ui-plan`, `ui-subagent` (header chip 「N 个子代理」 with per-child tokens + duration + running dot — works, screenshot `16-chat-subagent-menu.png`), `ui-deliverables`, `ui-workflow-run`, `ui-tool` (`tool.call.toolview`), chat details pane (「详情」: click a tool row).

## F4 The live run the owner was watching (run_9924d620…, session 73b4aa0f…, question: 70 岁以上阿司匹林一级预防 + ADR)
- Route: `adopted:runtime-ui:llm:0.82` → clinical-evidence-synthesis, model deepseek-flash.
- Parent: plan (3 deliverables: clinical-evidence, adr-analysis [capability id `adr-analysis` — check it exists], summary-brief with `dependsOn: []` although the parent's prose said it depends on the other two) → `evimed_delegate` ×2. Children ran SEQUENTIALLY: child 1 24m52s, child 2 started after.
- Parent transcript showed only 「深度求索中... 26分53秒」.
- Runs page showed 「交付进度 0/3 · 待开始 ×3」 and the notice 「已有约 15 分钟没有可观测的进展（…工作区也没有变化）」 while the child was writing files every minute and `.evimed-run/state.json` said item 1 `rejected, attempts 2`, `subagents[0].status running`, `gateRuns 2`. So: (a) deliverable status on the runs page is not refreshed from the projection; (b) the stall notice is false for delegated work — `recordProgress` (`agentRuns.mjs:4539-4662`) only lets root history or authenticated kernel activity reset the counter, and child activity was evidently not observed for a runtime-UI-adopted session; (c) the notice text claims the workspace did not change, which the monitor never checks.
- Usage (Postgres `evimed_usage.model_requests`, 22:26–22:54Z): 335 requests, 73.1 M cache-hit + 0.73 M cache-miss input tokens, 278 K output, ¥3.31. Context per request grows to ~320 K tokens, compaction drops it to ~135 K at 22:41, climbs again to 300 K.
- `evidence.byStatus`: queued 10, stale 145, ready 2 — the default project's workspace `workspace/2026-07-21-0836` still carries July's evidence store; 145 stale rows are counted into this run.

## F5 Where a deep run's steps go (finished run run_93e840c1…, kept project, 17 min)
362 messages; 190 tool calls: bash 106, write 27, read 7, edit 6 (=146 file/shell, 77%) vs research 29 (full text 13, source search 8, literature search 7, trial search 1), submit 5, plan 2, delegate 1, review 1, revise 1, complete 1, skill 3.
bash kinds: python-inline 55, grep/sed/awk 21, python-script 19, cat/ls 9. The model writes and re-writes its own `extract_quotes.py`, `build_matrix.py`, `verify_quotes.py`, `check_package.py`, `prose_check.py`, `fix*.py`, string-replaces claim markers in the report, greps preserved sources for verbatim quotes. The live run shows the same (`make_claims2.py`, `assemble3.py`, `build_matrix.py`, `matrix_parts.py`, `normalise_records.py`, `render.py`).
→ The matrix/quote/marker bookkeeping is hand-built per run with ad-hoc scripts. Candidate deterministic tools: quote locator over preserved sources, claim upsert with immediate quote+number verification, marker/matrix sync, report render. Each upsert is also a natural progress event.

## F6 Session open latency
Navigation → usable composer: 10.3 s (`/app/chat`) and 11.2 s (`/app/chat/:id`) with a warm runtime; frame attached at 1.8–3.1 s. Loading state is one line of grey text in an empty page (「正在启动研究运行时...」/「正在打开研究任务...」).
`/app/chat` without an intent re-opens the last session rather than a blank task.

## F7 Shell observations
- Bell: icon 14×14, badge 14 px tall × 15.4 px (1 digit) / ~22 px (2 digits) at `-right-0.5 -top-0.5`, font 12px/18px, bg `rgb(178,79,42)` → covers the icon. 
- Accent is rust `#B24F2A` on warm beige; frame is white with blue `rgb(65,118,230)` send button and `rgb(237,243,254)` user bubble; frame body font stack `-apple-system, …, "PingFang SC"`, 16px; bubble 14px/22px. Mark is blue #2563EB, favicon green #1f6f5c.
- A credentials banner (「7 个数据源本部署没有配置凭据…」去配置/稍后再说) sits on top of every page.
- Inbox items show raw English validator text ("claims[52].claim numeric fact 6 is not present in its direct support…").
- Recent-task rows: eleven identical 「临床证据深度分析」 titles; legacy runs have no question text; newer runs carry `question`.
- Runs page row for a running run: 「技术标识（供排查使用）」, 「复查与复现」, 「打开对话」, 交付进度 list, 核验提示 box.
- Capabilities page: 15 tall cards with two-letter monograms (SA/BA/CS/CE), est. duration 「约 20–120 分钟」.
- Console noise in the frame: 403 on `dynamicCordisRunner/syncInspect` every boot; `Runtime stream capacity` is also thrown when the transport is merely disposed (`runtimeUiTransport.mjs:160`).

## F8 Frame token inventory (live, 358 `--dsw-*` names; values in `dsw-tokens-live.json` came back empty because they are set below `:root`)
Groups: `font-markdown-*` 102, `static-neutral-*` 35, `alias-button-*` 15 (primary-fill/hover/dimmed, ghost, floating, info, tool-bar), `alias-bg-*` 13 (base, layer-1..3, masks, overlay, skeleton), font rungs `font-{xxxs-11,xxs-12,xs-13,s-14,base-16,m-18,l-20,xl-24}` each with family/size/style/weight/line-height, `static-blue-*` 12, `static-deepseek-*` 11 (the vendor blue ramp), `alias-state-*` 11 (business/error/success/warn primary/secondary/tertiary), `alias-label-*` 9 (primary, primary-bluish, secondary, tertiary, caption, dimmed, inverted), `alias-markdown-*` 8 (citation, code-block, inline-code, tag…), `alias-border-l1..l4`, `alias-interactive-bg-*` 5, `alias-brand-primary`/`-invert`/`-text`, `specific-bubble`/`-highlight` (the user bubble), `specific-sidebar-*`, `specific-input-major`, `linear-gradient-think` + `linear-think-select` (the 「深度求索中」 gradient), `alias-link`, `shadow-lv1..3`, `elevation-*`, `corner-shape`, `font-family`.
→ A brand re-skin of the frame is ~25 alias/specific token overrides (brand-primary, button-primary-fill/hover, specific-bubble, linear-gradient-think, alias-link, alias-bg-*, alias-label-*, font-family, font rungs) in our injected stylesheet — the same CSS-variable surface the kernel's own theme plugin writes.
