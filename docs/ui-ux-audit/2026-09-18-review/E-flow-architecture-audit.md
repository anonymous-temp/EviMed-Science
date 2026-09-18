# E — Flow & architecture audit (read-only), 2026-09-18

Scope: end-to-end algorithm architecture, flow and logic of a deep run on the hosted
EviMed SaaS (`OpenScience/`), read against the repo's 20 development principles.
Companion to `00-live-findings.md` (measured production facts F1–F7, not re-measured here).
All paths relative to `/home/coder/workspace/EviMedScience/OpenScience` unless stated.

Status: **COMPLETE**.

- [x] 1. Where the child's 190 steps come from
- [x] 2. First-turn cost
- [x] 3. Context growth and compaction
- [x] 4. Concurrency
- [x] 5. Routing & dispatch
- [x] 6. Progress observability (root causes found)
- [x] 7. Medical-expertise levers
- [x] 8. Model strategy
- [x] 9. Reliability & state
- [x] 10. Memory
- [x] Sequence diagram
- [x] Findings table
- [x] Progress events we have vs need
- [x] Top 12 changes
- [x] Open questions

---

## 1. Where the child's 190 steps come from

### 1.1 The tool surface has no evidence-bookkeeping primitive

`packages/domain/src/toolNames.mjs:40-95` is the complete model-visible vocabulary:
33 MCP research tools (`mcp__evimed__*`) and 10 socket tools (`SOCKET_TOOL_NAMES`,
`toolNames.mjs:99-110`): `evimed_plan`, `evimed_delegate`, `evimed_revise_deliverable`,
`evimed_submit_deliverable`, `evimed_complete_run`, `evimed_capsule_recall`,
`evimed_capsule_note`, `evimed_screen_batch`, `evimed_review_run`, `evimed_compact_request`.

Every MCP tool is **retrieval or compute**. Every socket tool is **workflow control**.
**There is no tool anywhere that touches the evidence matrix, a claim, a quote, or a
claim marker.** The unit of interaction with the deliverable is `submit` — all or nothing,
after the model has built the whole thing by hand.

That is the structural explanation for F5: of 190 tool calls in a 17-minute run,
146 (77%) were bash/write/read/edit, and 55 of the 106 bash calls were inline Python.
The model is not misbehaving; it is doing the only thing available.

### 1.2 What the SKILL.md asks for, and what it costs in steps

`capabilities/clinical-evidence-synthesis/SKILL.md` is 1841 lines / **142 432 bytes**, and
all of it is pre-injected into every child (§2.4). The artifact contract
is two files (`capability.yaml:38-48`: `clinical-evidence-report.md` +
`clinical-evidence-matrix.json`), but the *per-claim* obligations are large and entirely
manual:

| Obligation | SKILL.md | Work the model must do by hand |
|---|---|---|
| 11 required fields per direct claim | `SKILL.md:1080-1094` | build JSON rows |
| `supportQuote` verbatim in the preserved artifact | `SKILL.md:1094` | grep/python over `.evimed-sources/` |
| every numeral in the claim also in the quote/title/id | `SKILL.md:1094` | numeric diff per claim |
| `artifactPath` copied from a tool result, never typed | `SKILL.md:1100` | cross-reference tool outputs |
| synthesized claims: ≥2 *distinct* artifactPaths, each with its own quote | `SKILL.md:1118-1120` | de-dup by path, count |
| `pico`/`picoMatch`/`denominatorKind`/`requiredCaveats` per claim | `SKILL.md:1122-1138` | per-claim judgement + registry |
| every `requiredCaveats.forms` entry must appear in the report body | `SKILL.md:1137-1142` | string search per form per claim |
| derived claims: numerals must appear in `method`/`assumptions`/`sensitivity` | `SKILL.md:1175` | numeric diff again |
| `[n]` numbering resolves to the reference list, in first-appearance order | `SKILL.md:1041-1051` | renumber on every edit |
| hidden `<!-- claim:CLM-NNN -->` on the same physical line as its proposition | `SKILL.md:1046-1047` | marker sync on every edit |
| no visible `[claim:...]` marker remains | `SKILL.md:1664` | final sweep |

Two instructions actively push the model *into* writing Python rather than using tools:

- `SKILL.md:1656` — **"Do not use `grep` or another unbounded line-oriented search on a
  generated report"**, followed by "use bounded `read` ranges and the platform's
  deterministic completion validator instead". There is no such validator on the tool
  surface, so the model substitutes its own script.
- `SKILL.md:1744-1770` — the skill **ships an inline Python heredoc** as a required
  finishing step (paragraph-shape printer + a 22-phrase watch list), with the comment
  "which is why `grep` is forbidden on the report and this is not". A second script call
  follows at `SKILL.md:1797-1802` (`manuscript-humanize/scripts/verify_preserved.py`).

So the skill's own closing procedure is "write and run Python". Once a run is in that mode
for the prose check, doing the matrix the same way is the locally cheapest choice —
which is exactly `build_matrix.py`, `extract_quotes.py`, `verify_quotes.py`, `fix*.py`
in F5, and `make_claims2.py`, `assemble3.py`, `matrix_parts.py`, `normalise_records.py`,
`render.py` in F4.

This also violates principle 1 in the repo's own terms: verbatim quote matching, numeral
membership, marker resolution and reference renumbering are **deterministic properties**
("schemas, file existence, verbatim quote matching, numbers"), and they are currently
placed in the model. The domain already contains the checking half of every one of them
(`packages/domain/src/clinicalEvidence.mjs`, ~3.8k lines) — it is only reachable as a
**verdict on a finished package**, never as a **tool during construction**.

### 1.3 Why runs still make 5 submissions

`packages/socket/plugins/run-policy.mjs:756-858` is `evimed_submit_deliverable`.

- Budget: `deliveryAttemptLimit` default **3** (`run-policy.mjs:100`), plus a separate
  `structuralAttemptAllowance` default **3** (`run-policy.mjs:102`) for submissions the
  gate could not read at all (wrong matrix schema, missing file). Charged at
  `run-policy.mjs:802-810`. So **up to 6 submissions** are reachable — which is why F5
  observed 5.
- The structural allowance exists because, per the comment at `run-policy.mjs:793-801`,
  "Two runs spent four such submissions each before any content rule had run at all, then
  met eighty-three findings with three attempts left." That is a diagnosis of the same
  defect from the other end: **the run learns the contract by failing submissions**,
  because nothing lets it check a single claim as it writes it.
- What the model sees back: `rejectionEnvelope(verdict)` — `{ok:false, code, issues:[...]}`
  where each issue is `{code, severity, message}` with severity `required`/`advisory`
  (`run-policy.mjs:823-838`). The entire package's findings arrive at once; in the v9
  measurement one submission returned 83 findings.
- Exhausted budget is a hard refusal, including for a *new* child:
  `run-policy.mjs:616-618` refuses `evimed_delegate` for a deliverable whose submissions
  are spent, with the comment recording a v10 cell where a second child researched for
  30 minutes and could not submit.

**The loop is the product's single largest time sink** (63% of run time in the v9
measurement, PROGRESS 2026-09-17 12:00) and it is entirely a consequence of 1.1: a
compile-then-run-the-whole-test-suite cycle where a type checker would do.

### 1.4 What deterministic tools would remove, and where they belong

All four live behind the same already-written domain rules, so none of them is a new gate
(principle 4 is not engaged — these are *return values during construction*, not blocking
points; principle 3 explicitly asks for compiler-style verdicts):

| Proposed tool | Home | Why there | What it deletes |
|---|---|---|---|
| `evimed_locate_quote{artifactPath, text}` → offsets + exact-match verdict + nearest near-miss | **MCP** (`runtime/mcp/evimed-research`) | it reads `.evimed-sources/`, which is the MCP server's own output area; no kernel seam needed | `extract_quotes.py`, `verify_quotes.py`, the grep/sed/awk class (21 calls in F5) |
| `evimed_claim_upsert{claim…}` → per-claim verdict (quote bond, numeral membership, PICO/caveat completeness, distinct-source count) | **socket** (`run-policy` or a new `evidence-claims` plugin) | it must call `packages/domain/src/clinicalEvidence.mjs` — the same module the gate uses — and the socket is where `@evimed/domain` is already imported | `build_matrix.py`, `make_claims2.py`, `normalise_records.py`, most of the resubmission loop |
| `evimed_render_report{}` → renumbers `[n]`, syncs `<!-- claim: -->` markers to the matrix, emits the reference list | **socket** | it must write the deliverable atomically and re-verify markers with the same rules | `assemble3.py`, `render.py`, `fix*.py`, the marker string-replacement class |
| `evimed_package_check{deliverableId}` → the full verdict **without spending a submission** | **socket** | a read-only pre-flight over the same `gateDeliverable` call | the structural allowance (`run-policy.mjs:102`) and most of the 5 submissions |

`evimed_package_check` is the cheapest of the four and the one the SKILL.md already
implies exists ("the platform's deterministic completion validator", `SKILL.md:1656`).
It is a pure refactor: `gateDeliverable(...)` at `run-policy.mjs:784-792` called from a
second tool that does not touch `entry.attempts`.

**What the SKILL.md would say instead**: the eleven-field table at `SKILL.md:1080-1094`
becomes the tool's parameter schema (principle: "improve what the model receives");
`SKILL.md:1656-1669`'s twelve-bullet self-check list becomes `evimed_package_check`'s
output; `SKILL.md:1744-1770`'s Python heredoc is deleted and becomes a `notice` from the
same tool. The prose *judgement* (the four questions at `SKILL.md:1772-1786`) stays in the
skill, because that is language judgement (principle 1) — only the printer is mechanised.
Estimated SKILL.md reduction: the sections at 1053-1190 and 1641-1841 are ~350 lines of
procedure that become tool schema and tool output.

**Each upsert is a progress event** — see §6.4. A run that calls `evimed_claim_upsert`
72 times (the v11 report carried 72 claims) emits 72 medically meaningful ticks; today
those same 72 claims arrive as one `submit` at minute 24.

---

## 2. First-turn cost

Measured where possible against a **real recorded 0.1.5-rc.1 wire frame** in the repo —
`apps/server/test/fixtures/dsh/golden-frames-0.1.5-rc.1.json` — which carries the exact
assembled system prompt and tool array the kernel sent. Divisors: **chars/3** for
Chinese-heavy text, **chars/4** for English JSON. Stated per row.

### 2.1 Decomposition of the parent's first request

| Component | Where | Chars | Tokens | Cacheable? |
|---|---|---|---|---|
| kernel identity + tool prompt sections (the rows our preset mounts) | `@deepseek-ai/dsh-system-prompt@0.1.5-rc.2` `lib/index.js:10-41, 212-217`; recorded prompt 6 874 chars total | ≈3 200 | ≈800 (/4) | yes |
| our persona (replaces the kernel's coding-agent prefix) | `packages/socket/presets/evimed-universal/agent.cordis.yml:20-28` | 316 | ≈105 (/3) | yes |
| **our orchestration guidance** | `packages/socket/src/guidanceText.mjs:28` | **7 100** | **≈2 367 (/3)** | yes |
| — of which the capability catalogue (15 × ~255) | `guidanceText.mjs:56-60`, `capabilityManifest.mjs:336-339` | 3 831 | 1 277 | yes |
| — of which skill-root guidance | `packages/domain/src/skillRoots.mjs:88-105` | 1 004 | 335 | yes |
| **answer persona: the whole `open-domain-answer/SKILL.md`** | `packages/socket/plugins/guidance.mjs:90-96, 138-146` | **≈7 650** | **≈2 550 (/3)** | yes |
| **tool schemas — 63 tools** | see 2.2 | **≈62 150** | **≈16 160** | yes |
| `<evimed-brief>` + `context.md` + capsule + agenda, as one **user** message | `packages/socket/plugins/run-policy.mjs:1174-1189` | up to **44 500** | up to **≈14 800 (/3)** | appended at the tail — cache-safe |
| — memory block | cap 8 items / **20 000 chars** (`apps/server/src/memorySubstrate.mjs:129-130`, `config.mjs:1103`) | ≤20 000 | ≤6 667 | |
| — knowledge block | cap **12 000** chars / topK 6 (`researchContext.mjs:277-278`) | ≤12 000 | ≤4 000 | |
| — `<evimed-specialist>` catalogue (11 entries, **duplicates the capability catalogue**) | `researchContext.mjs:369-379` | ≈3 244 | ≈1 081 | |
| — a **second copy** of `open-domain-answer/SKILL.md` | `researchContext.mjs:389-394, 464-469` | 7 530 | ≈2 510 | |

That reconciles with the ~55 K first turn: roughly **22 K of cacheable system prompt +
tool schemas**, plus up to **~33 K of per-dispatch user-slot context**. The recorded frame
confirms the caching works: request 1 `inputTokens 21470, cacheReadTokens 0`;
request 2 `inputTokens 206, cacheReadTokens 21504`.

### 2.2 The tool array is the single largest block

63 tools for the parent (`agent.cordis.yml:31-250`; MCP row inserted at
`apps/server/src/dshProfilePatch.mjs:201-224`):

| group | count | chars | tokens |
|---|---|---|---|
| kernel builtins (`bash` 3 290, `workflow` 4 067, `subagent` 1 481, `list_agents` 1 364, `edit` 1 116, …) | 15 | 17 713 | 4 428 (/4) |
| `mcp__evimed__*` | 34 | **37 674** | **9 419 (/4)** |
| socket `evimed_*` | 9 | ≈5 220 | ≈1 800 (/3) |
| `cite_*` (`dsh-cite@0.3.2`) | 5 | 1 541 | 514 (/3) |
| **total** | **63** | **≈62 150** | **≈16 160** |

Of the MCP block, **78% is `inputSchema`, not description** (29 988 vs 5 977 chars), and
four single-consumer tools are 44% of it: `comprehensive_drug_evaluation` 4 788,
`mendelian_randomization` 4 203, `offlabel_evidence_packet` 4 068,
`drug_selection_evaluation` 3 901 — each requested by exactly one capability manifest.

### 2.3 Prefix stability: correct by construction

**Verdict: the request is ordered stable-prefix-first and the ordering is right.** Nothing
per-run or per-turn sits in the system prompt or the tool array:

- `buildGuidanceText` is a pure function of boot-time manifests plus three booleans read
  from container env — byte-identical for the container's life (`guidanceText.mjs:28`).
- Tool schemas serialize as `{name, description, parameters}` and are ordered
  lexicographically when no `toolOrder` is set (`dsh-system-prompt/lib/index.js:82-91,
  321-326`) — deterministic.
- Everything per-run enters as a **user** message: `injectContext` builds `role: 'user'`
  (`packages/harness-port/index.mjs:477-492`), and the kernel's runtime-context snapshot is
  likewise separate from the system prompt (`dsh-system-prompt/lib/index.js:130-134`).
- **No date/time anywhere in the prompt path.** The `new Date()` in
  `researchContext.mjs:230` writes a knowledge *index file*, not prompt text.
- No workspace listing: `agent-instructions` (which would inject AGENTS.md from every
  touched directory) is deliberately unmounted (`agent.cordis.yml:259-261`).

Four residual risks, in priority order:

1. **Skill-catalogue timing — the one thing to instrument.** `@deepseek-ai/dsh-skill`
   exposes "sorted summaries plus discovery-completeness state"
   (`dsh-skill/lib/index.js:228-232`) and `skill-filesystem` scans 5 roots / **57 skills**
   at session start (`agent.cordis.yml:160-190`), whose frontmatter alone is **17 315
   chars**. If `dsh-tool-skill` renders that into a system-prompt section and discovery has
   not settled at first assembly, the prefix changes between step 1 and step 2. **Not
   determined** — that package is not in this checkout.
2. `registerSkill` for capsule methods (`packages/socket/plugins/capsule.mjs:51-62`, ≤32
   entries / 32 KB) feeds the same catalogue; it is awaited inside `apply()` so it should
   land first, but shares risk 1's unknown.
3. **ToolUniverse is `failOnStartupError: false`** (`dshProfilePatch.mjs:378`). If that
   sidecar is ever configured and flaps, its tools appear/disappear inside the tool array
   and kill the cached prefix. Latent, not active. (The MCP row is `failOnStartupError:
   true`, `:218` — correct.)
4. `GUIDANCE_SECTION_ORDER = 120` (`guidanceText.mjs:20`) is documented as "DSH's
   tool-guidance band 100–199", but in 0.1.5 the tool band starts at `TOOL_BASH: 1000`
   (`dsh-system-prompt/lib/index.js:18`). Our 7.1 KB lands between the persona prefix (0)
   and `PLAN_POLICY` (500) — *ahead of* the kernel's tool guidance, not inside it. Harmless
   for caching; the comment is wrong and the placement is not what it claims.

### 2.4 The child's first message is far larger than the parent's

**This is the biggest single number in the audit and it is not the parent's problem.**
`readSkillBodies` (`run-policy.mjs:631, 1243-1248`) splices every manifest-listed SKILL.md
**verbatim** into the child's first user message under `## 方法`
(`packages/socket/src/runPolicy.mjs:649`), with **no size cap and no diagnostic**:

| capability | skills | pre-injected bytes | tokens (/3) |
|---|---|---|---|
| **clinical-evidence-synthesis** | 6 | **158 088** | **≈52 700** |
| dataset-research-scoping | 5 | 69 828 | ≈23 300 |
| geo-content | 6 | 26 247 | ≈8 700 |
| manuscript-support | 5 | 26 107 | ≈8 700 |
| evidence-appraisal | 4 | 23 330 | ≈7 800 |
| peer-review | 1 | 2 726 | ≈900 |

`capability-skills/clinical-evidence-synthesis/SKILL.md` alone is **142 432 bytes**. So a
clinical child starts at ~53 K tokens of instructions before its first tool call, and every
one of its ~190 steps re-sends them. That is the floor under §3's 220 K average — and it
explains why compaction fires: the instructions are ~25% of the ceiling before any evidence
is read.

The answer persona is capped at 32 000 chars (`guidance.mjs:36`); `readSkillBodies` is not.

### 2.5 What to defer or shorten, by measured saving

| # | Change | Evidence | Saving |
|---|---|---|---|
| 1 | **Apply `ROOT_VISIBLE_MCP_BASE_NAMES` to the root.** The constant exists (`toolNames.mjs:123-129`) and is referenced nowhere; the parent is told not to retrieve before delegating (`guidanceText.mjs:50`) and children already get exactly their manifest's tools | measured 37 674 → 3 912 | **−33 762 chars ≈ −8 440 tokens** |
| 1a | If (1) is too aggressive: drop just the four single-consumer giants from the root | measured | −16 960 ≈ −4 240 |
| 2 | **Stop double-injecting `open-domain-answer/SKILL.md`** — it is in the system prompt *and* again in `context.md` every dispatch. Keep the cacheable copy | `guidance.mjs:90-96` vs `researchContext.mjs:389-394` | **−7 530 chars/turn ≈ −2 510 tokens/turn** |
| 3 | **Drop `tool-workflow`** — no skill, manifest or code path references `workflow` | `agent.cordis.yml:249-250`; grep | −4 392 ≈ −1 100 |
| 4 | **Drop `tool-subagent` + `tool-subagent-control`** — delegation uses `ctx.subagents.start`, the service, not the tool; `send_message` is not in `DELEGATION_BASE_TOOLS` so no child can use it | `harness-port/index.mjs:561-570`; `capabilityManifest.mjs:39-55` | −4 342 ≈ −1 085 |
| 5 | **Collapse `<evimed-specialist>` into the system-prompt capability catalogue** — 11 entries restating `## 能力目录`, re-sent every dispatch | `researchContext.mjs:369-379` | −3 244/turn ≈ −1 081/turn |
| 6 | Lower `memoryContextMaxChars` (20 000) or move the block behind `evimed_capsule_recall`, which every session and child already has | `config.mjs:1103` | ≤−20 000/turn |
| 7 | Lower `knowledgeContextMaxChars` (12 000) / `knowledgeTopK` (6) | `researchContext.mjs:277-278` | ≤−12 000/turn |
| 8 | Move skill-root guidance into the `skill` tool's **result**, where a relative path actually needs resolving | `skillRoots.mjs:88-105` | −1 004 |
| 9 | **Cap `readSkillBodies`** the way the answer persona is capped, with a diagnostic | `run-policy.mjs:1243-1248` vs `guidance.mjs:36` | up to **−110 000 bytes ≈ −36 700 tokens per delegation** |
| 10 | De-duplicate the two 142 432-byte copies of the clinical SKILL.md (image size and drift, not prompt) | `capabilities/` vs `capability-skills/` | — |

**Net on the parent's first request** from 1–5 and 8: **≈−54 300 chars ≈ −14 500 tokens**,
about a quarter of the 55 K first turn, with no behavioural change to the parent's dispatch
role. Items 6–7 cut a further ≤32 K chars *per dispatch*. Item 9 is the one that moves §3's
needle.

---

## 3. Context growth to 320 K, and compaction

### 3.1 The arithmetic

Measured (F4): 335 model requests, 73.1 M cache-hit + 0.73 M cache-miss input tokens in
28 minutes. **73.8 M / 335 ≈ 220 K input tokens per request, average.** Context observed
climbing to ~320 K, compacted to ~135 K at 22:41, back to ~300 K by the end.

Compaction defaults, recorded from the pinned backend at
`packages/harness-port/src/compaction.mjs:224-228`:

```
policy: 'basic', thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192
```

and shipped unchanged into the container at `apps/server/src/dshProfilePatch.mjs:543-546`
and `deploy/runtime-dsh/build-smoke.sh:140-141`. The window is
`runtimeContextWindow` = **400 000** (`apps/server/src/config.mjs:1307-1309`), so the
trigger is at **exactly 320 000 tokens** — precisely where F4 measured the peak. The
comment at `config.mjs:1295-1301` records that this was previously a literal 1 000 000
against a 400 K budget, so compaction had *never* fired in this deployment before the fix.

A hard wall sits just above: at ~320 K tokens the serialized request body is ~1.3 MB
against `modelGatewayMaxBodyBytes` = **2 MiB** (`config.mjs:1077-1079`,
`deploy/web/.env.example:316`). Exceeding it is a `413 model_gateway_body_too_large`
(`apps/server/src/modelGateway.mjs:198-209`) with **no retry** — a run that grows its
context faster than compaction can trigger dies outright.

So: **the run compacted once in 28 minutes and spent the rest of its life carrying a
200–320 K context through 335 round trips.** Cost is not dominated by the answer; it is
dominated by re-sending the transcript. 99% of input tokens were cache hits, so the prefix
caching is working — the problem is the *volume of cached prefix*, not a cache miss.

### 3.2 What fills it

Not measured directly (would need the container transcript), but the tool mix in F5 names
the candidates in order:

1. **Full-text reads.** `mcp__evimed__open_access_full_text` preserves a paper under
   `.evimed-sources/` and the model then reads it. 13 full-text calls in F5.
2. **Its own script output.** 55 inline-Python calls, each printing matrix fragments,
   quote candidates and paragraph tables back into the transcript. The heredoc at
   `SKILL.md:1744-1770` prints one line per paragraph of a 60 KB report — roughly 100
   lines, every time it is run, and it is run at least twice (steps 1 and 5).
3. **`read` of its own deliverable.** `SKILL.md:1656` forbids grep and directs bounded
   reads, so a 62 KB report is re-read in slices repeatedly.
4. **Gate verdicts.** Up to 83 findings per submission, up to 6 submissions.

### 3.3 What a narrower per-source extraction step would change

A fan-out shape — one short-lived worker per preserved source, each returning only
`{claimId, quote, offsets, pico, numerals}` — changes the arithmetic rather than the
prompt. The full text enters a 20 K-token child context and never enters the 320 K parent.
The domain already has the vocabulary for it; what is missing is the same thing as in §1:
a tool whose *result* is a claim row rather than a wall of text.

**DSH native sub-delegation** is present and already used: `startSubagent` /
`awaitOwnedSubagent` (`packages/socket/plugins/run-policy.mjs:655, 677`), with
`maxParallelChildren` default **30** (`run-policy.mjs:104-105`). `packages/socket/plugins/screening.mjs`
already carries its own `maxParallelChildren` (`screening.mjs:37`) for batch screening,
which is precisely this shape applied to title/abstract screening. So the mechanism exists
and is used once; extending it to per-source extraction is a plugin change, not a kernel
change.

Cheapest lever available today with no code change: **lower `EVIMED_COMPACTION_THRESHOLD_RATIO`**
(`compaction.mjs:243`, forwarded at `dshProfilePatch.mjs:544`). Compacting at 0.5 instead
of 0.8 roughly halves the average carried context. It is a one-line env change with a
measurable control (principle 11), and the handle-preserving engine
(`packages/socket/plugins/compaction.mjs`) already protects plan/source/deliverable ids
across a compaction.

---

## 4. Concurrency — why two children ran sequentially

**Cause: `evimed_delegate` awaits the child inside its own tool call.**
`packages/socket/plugins/run-policy.mjs:677`:

```js
const outcome = await awaitOwnedSubagent(run, childSessionId)
```

The tool does not return until the child has finished (and, at `run-policy.mjs:705-743`,
may start a *second* child serially on failure). So a parent that emits one
`evimed_delegate` call, waits, then emits the next, runs its children strictly in series —
which is exactly F4 (child 1 = 24m52s, child 2 started after).

**A second, independent serialiser sits underneath it.** `defineTool` supports DSH's
parallel-tool-call opt-in (`packages/harness-port/index.mjs:141,153`):

```js
...(spec.concurrencySafe === undefined ? {} : { isConcurrencySafe: () => Boolean(spec.concurrencySafe) })
```

The kernel's own type doc calls this "Whether this call may join a parallel group"
(`@deepseek-ai/dsh-tools@0.1.5-rc.2` `lib/types/index.d.ts:151-153`). Exactly two tools in
the repo set it — `packages/socket/plugins/capsule.mjs:94` and
`packages/socket/plugins/compaction.mjs:145`. **`evimed_delegate` does not**
(`run-policy.mjs:592-604`), so even a parent that emitted two delegate calls in one
assistant message would not get a parallel group. (Whether the kernel's default is
deny-unless-declared is **not determined** — only the declaration is resolvable here.)
`modelGateway.mjs:305-307` likewise validates `parallel_tool_calls` and never sets it.

**The kernel and our own code already do fan-out.** `packages/socket/plugins/screening.mjs:93-94`
uses the *same* `startSubagent` seam with `Promise.all` over waves of
`config.maxParallelChildren`. So the capability exists, is exercised in production by
`evimed_screen_batch`, and is simply not exposed by `evimed_delegate`.

Ruled out as causes:
- **Not a concurrency cap — and the knob's name is a misnomer.** `maxParallelChildren`
  default **30** (`run-policy.mjs:104`, `apps/server/src/config.mjs:796-798`) maps onto
  `limits.maxChildren` (`run-policy.mjs:244`), which `packages/socket/src/runPolicy.mjs:156-158`
  uses as a **lifetime total** (`entry.budget.children += 1` at `run-policy.mjs:670` is
  never decremented). The same env var means "concurrency wave size" in `screening.mjs:93`
  and "lifetime ceiling" in delegation.
- **Not a queue.** There is no queue, mutex or semaphore anywhere in `packages/socket/src/`.
  Dependency handling is a **refusal**: `run-policy.mjs:619-623` returns
  `deliverable_dependency_pending`.
- **Not the run-level caps**, though they bound the ceiling: `maxConcurrentTasksPerProject`
  default **1** and `maxConcurrentTasks` **2** (`config.mjs:662-664`,
  `deploy/web/.env.example:455-456`) mean parallel delegation would still be one project's
  run at a time.

**A documentation/behaviour mismatch the model reads.** The tool description says
「依赖未满足时会排队，不需要你自己排序」 ("unmet dependencies are queued; you don't
need to order them yourself", `run-policy.mjs:596`) — but the code refuses instead of
queueing (`run-policy.mjs:619-623`). Nothing in the description or in `guidanceText.mjs`
tells the model it may issue several `evimed_delegate` calls in one assistant turn. Whether
the kernel executes same-turn tool calls concurrently is **not determined** from this repo.

**`dependsOn` is declared and enforced, not advisory.** Declared in the plan schema at
`run-policy.mjs:540`, stored at `run-policy.mjs:572`, and enforced through
`delegatableItems(entry.plan, entry.items)` (`packages/socket/src/runPolicy.mjs:336`,
used at `run-policy.mjs:619`) which only admits an item whose dependencies are `accepted`.
So F4's parent writing `dependsOn: []` for the summary while its prose said it depended on
both was a *modelling* error with a real consequence: the summary was eligible immediately
and could have been delegated before its inputs existed. Nothing checks the plan's prose
against its `dependsOn`, and nothing asks the model to confirm the graph.

**What parallel delegation would cost/risk** (for the control experiment). Assume the fix
is a non-blocking `evimed_delegate` returning a child handle, plus an `evimed_await` join,
plus `concurrencySafe: true`:

- **Budget counters become arbitrary.** `state.budget.tokens` is one run-wide counter
  checked at `packages/socket/src/runPolicy.mjs:153-155`; with N children in flight the
  refusal lands on whichever tool call happens to arrive after the threshold. Same for
  `maxSteps`.
- **Model rate limits.** All children share one gateway credential and nothing throttles
  per run. `maxParallelChildren` would have to become a genuine wave size (as
  `screening.mjs:93` already treats it) or nothing bounds the fan-out but the lifetime
  ceiling of 30.
- **Workspace write conflicts are detected, never refused.** `concurrentWriteNotice`
  (`packages/socket/src/runPolicy.mjs:199-209`, used at `run-policy.mjs:394-405`) only
  calls `diagnostics(...).degrade(notice)`. Later write silently wins. Children are fenced
  to `deliverables/<id>/` by convention (`run-policy.mjs:595`), not by the path guard, so
  the real exposure is two children told to write the same path.
- **The sharpest risk: `evimed_submit_deliverable` read-modify-writes across two awaits.**
  `entry.attempts` is read at `run-policy.mjs:778`, two `await`s intervene
  (`readDeliverableFiles`, `collectSourceArtifacts`, `:782-783`), and the write lands at
  `:808`. `sessionState` is a plain in-memory `Map` with no lock, and `putPlanIndex`
  persists the **whole entry** (`:672, 695, 717, 750`). Per-deliverable attempt keys make a
  same-key collision unlikely, but the whole-entry persist is last-writer-wins.
- The gate itself is per-deliverable (`run-policy.mjs:767-775` binds a child to one
  deliverable), so verdicts do not interfere.

Wall-clock prize for F4: 26m53s → ~13m. The prerequisite work is a per-entry write lock
around the submit/persist path — small, and needed anyway.

---

## 5. Routing & dispatch

### 5.1 The decision order

Only when `boundSession?.mode === "open-domain"` (`apps/server/src/server.mjs:2709`):

1. **`routeNamedSpecialist`** (`apps/server/src/specialistRouting.mjs:184-189`) — substring
   match of a capability **id** in the lowercased query, after stripping `《…》` spans.
   Outranks everything, including the model.
2. **`SpecialistClassifier.classify`** (`apps/server/src/specialistClassifier.mjs:120-209`)
   — a blocking model call on the critical path (`await` at `server.mjs:2712`, before
   `agentRuns.dispatch`).
3. **`routeOpenDomainSpecialist`** (`specialistRouting.mjs:191-258`) — the regex safety net,
   only if 1 and 2 both returned null. It may *add* a route, never override the model.
4. **Fallback** — `open-domain-answer` (`server.mjs:2730-2732`).

Threshold **0.75** (`specialistClassifier.mjs:88-89`, `config.mjs:938-939`,
`deploy/web/.env.example:277`); below it → open-domain.

One design detail worth keeping: `afterCleanNone` (`server.mjs:2714-2716`). When the model
*affirmatively* says "no specialist", the net's broad catch-all narrows to the
pharmacist-owned medicine list (`specialistRouting.mjs:246-249`) — the rationale at
`:232-238` records that a broad rule had overturned 50 correctly-declined briefs. This is
principle 5 applied correctly: the model judges, code narrows rather than widens.

### 5.2 The classifier is a full reasoning turn on the critical path

- Model `deepseek-flash`, `stream: false`, `temperature: 0`, `max_tokens: 8_000`,
  `response_format: json_object` (`specialistClassifier.mjs:146-170`).
- **No retry** (`docs/REQUEST_PATH.md:141`).
- Effective timeout **120 s**: `clamp(modelGatewayTimeoutMs, 1_000, 120_000)`
  (`specialistClassifier.mjs:90`) against a production `modelGatewayTimeoutMs` of 300 000,
  so **the configured value is never the effective one** (contradiction C7,
  `docs/REQUEST_PATH.md:341`). It is also a *streaming idle* budget being used as a
  *single-shot total*.
- Typical latency: **not determined** — no p50/p95 is recorded anywhere. The one hard
  datapoint is indirect and telling: the `max_tokens` comment at
  `specialistClassifier.mjs:150-163` records that at 200 tokens, six of six live calls
  burned the whole budget on 900–1000 characters of `reasoning_content` and returned
  empty. So this is a reasoning turn, not a classification turn. It is a plausible
  contributor to F6's 10–11 s session-open latency, though F6 measures a different path.
- Every failure mode resolves to `null` → open-domain, never an exception
  (`specialistClassifier.mjs:173-206`): `http_<status>`, oversized response, `unparseable`,
  `empty_content`, `timeout`, unknown id, low confidence. Surfaced as **one stderr line**
  (`:115`) plus a ledger reason suffix `:classifier:<code>`.
- It **bypasses the model gateway** and calls `api.deepseek.com` directly with the
  deployment key (`:139-146`), so it is unmetered (§8.3) and `reasoning_effort` is not
  applied to it.

### 5.3 Answer line vs delivery line — the user is neither told nor able to choose

The distinction is carried in prose, in the classifier's own instruction
(`specialistClassifier.mjs:67-68`): "Route only when the user actually wants that
deliverable — a plain clinical or scientific QUESTION ... stays open-domain even when it
mentions a drug, disease, or symptom." The regex equivalent is `explicitReportIntent`
AND'd with a subject (`specialistRouting.mjs:116, 250`).

- **Not told at decision time.** `effectiveAgentId` / `effectiveRouteReason` go on the
  ledger row (`server.mjs:2755-2758`), and only `effectiveAgentId` is rendered — on the
  **runs list, after the fact** (`apps/web/src/app/routes/RunsPage.tsx:618-619`,
  `apps/web/src/lib/runPresentation.ts:42-47`). `effectiveRouteReason` is typed
  (`apps/web/src/lib/apiClient.ts:606`) and **has no render site anywhere in `apps/web/src`**.
  The live session surface is the kernel's own UI iframe
  (`apps/web/src/app/routes/SessionRoute.tsx:94`), which carries no routing banner.
- **Not overridable.** `PUT /api/research-sessions/:id` supports
  `{mode:"specialist", agentId, agentVersion}` (`server.mjs:2607-2608`,
  `apiClient.ts:468-470`) and `server.mjs:2709` honours it by skipping routing entirely.
  But `putWebResearchSession` (`apiClient.ts:1395-1406`) has **no call site in the shipped
  UI** — the only reference outside its definition is a unit test. The one affordance is
  the capability card, which prefills a brief and says so explicitly:
  「这是建议，不是绑定。」 (`apps/web/src/app/routes/CapabilitiesPage.tsx:118-121`).
  Note a possible seam: `routeNamedSpecialist` matches the **id**
  (`specialistRouting.mjs:187`) while the card prefills from `ui.title`; whether
  `capabilityBrief` embeds the id is **not determined**.
- **Wrong-line recovery is absent in both directions.**
  - *Wanted quick, got 30 min*: there is **no cancel affordance** — `apiClient.ts` has
    `cancelWebTask` (`:1602-1606`) but no `cancelWebAgentRun`. A `/api/agent-runs/:id/steer`
    endpoint exists (`server.mjs:2839-2868`, injects `<evimed-correction>`) with **no web
    call site**. The researcher waits it out.
  - *Wanted a report, got a chat answer*: the documented recurring failure.
    `specialistRouting.mjs:97-101` records a real request saying 写出所有的分析结果和报告
    that matched no verb and got a chat message; `:106-115` records the same for 一篇…论文,
    and notes that when the classifier then timed out the request became an open-domain
    answer "with no report and no gate." The only recovery is re-asking with different
    words.

This is the largest pure-UX gap in the flow, and none of the fixes require a new gate or a
new router: render `effectiveRouteReason` at dispatch time with a one-click "改用 X" that
calls the endpoint that already exists, and wire a cancel button to the endpoint that
already exists.

### 5.4 An unknown capability in a plan is discovered too late

**`evimed_plan` does not validate capability ids against the catalogue.**
`run-policy.mjs:546-576` calls `indexPlan(raw)`, and `packages/domain/src/plan.mjs:93-96`
checks only that the string is non-empty. `dependsOn` *is* fully validated there —
unknown dep, self-dep and cycle detection (`plan.mjs:113-126`, `findDependencyCycle` at
`:145-172`) — so the plan validator has the shape for this check and simply does not do it
for `capability`.

Validation happens only at delegation (`run-policy.mjs:624-629`): `capability_unknown`, or
`capability_background_only` for a `visibility: internal` package. The run does not fail
and does not fall back: the item stays `planned`, produces **no files**, and the model may
re-plan or finish with `{partial: true}`. So a typo'd capability id becomes *nothing
delivered*, discovered mid-run after the plan is already on disk and the user has been
shown a 3-item delivery list.

The fix is one lookup in the same `ctx.get('evimedCapabilities')` accessor the delegate
tool uses two functions later. Size S. It is not a new gate — it is moving an existing
check earlier (principle 3: the verdict arrives when it can still be acted on cheaply).

F4's plan named `adr-analysis`, which **does exist** (`capabilities/adr-analysis/capability.yaml`,
public, 20–40 min), so that run was not affected.

### 5.5 The catalogue

15 public + 3 internal (`visibility` defaults to `public`,
`packages/domain/src/capabilityManifest.mjs:120`; only `internal` is ever written, `:207`).

| capability id | visibility | est. minutes |
|---|---|---|
| `adr-analysis` | public | 20–40 |
| `bibliometric-analysis` | public | 20–120 |
| `clinical-evidence-synthesis` | public | 30–120 |
| `comprehensive-drug-evaluation` | public | 25–60 |
| `dataset-research-scoping` | public | 30–120 |
| `drug-selection` | public | 20–50 |
| `evidence-appraisal` | public | 20–75 |
| `geo-content` | public | 40–180 |
| `manuscript-support` | public | 15–60 |
| `mendelian-randomization` | public | 30–180 |
| `meta-analysis` | public | 30–180 |
| `off-label-analysis` | public | 15–35 |
| `peer-review` | public | 20–120 |
| `research-grant-development` | public | 25–90 |
| `research-topic-selection` | public | 20–90 |
| `method-distillation` | **internal** | 1–20 |
| `method-relations` | **internal** | 1–25 |
| `source-understanding` | **internal** | 1–15 |

The duration range is shown only on the catalogue page
(`apps/web/src/app/routes/CapabilitiesPage.tsx:195`), **never at dispatch time** — so a
researcher who types a question and is routed into a 30–120 minute run is not told that
before it starts.

---

## 6. Progress observability

### 6.1 Why the runs page showed 「待开始」 for an item the projection called `rejected, attempts 2`

**Root cause found: `scopeNativeProjection` (`apps/server/src/agentRuns.mjs:883-907`)
throws the projection's item statuses away and recomputes them from the *root session's
own tool calls*.**

The runs page reads `run.planItems` from the polled list endpoint
(`apps/web/src/app/routes/RunsPage.tsx:642`, `apps/web/src/lib/apiClient.ts:677`), which
is filled by `withPlanProgress` (`agentRuns.mjs:3167-3186`) from
`readRunStateProjection(project, project.workspaceDir, run)`.

For a run **adopted from the kernel's own UI** — F4's route was `adopted:runtime-ui:llm:0.82`,
so `run.nativeTurn` is set — `readRunStateProjection` takes the branch at
`agentRuns.mjs:2665`: `scopeNativeProjection(projection, run)`. That function, at
`agentRuns.mjs:895-900`, builds each item as:

```js
status: submission?.accepted ? "accepted"
      : submission?.rejected ? "submitted"
      : proof.delegates.includes(definition.id) ? "delegated"
      : "planned",
attempts: submission?.attempts ?? 0
```

where `proof.submissions` and `proof.delegates` come from scanning the **root session
transcript** (`agentRuns.mjs:840-863`) for `evimed_submit_deliverable` and successful
`evimed_delegate` tool calls.

Two facts make this always read `planned` while a child is working:

1. **The child submits, not the parent.** `evimed_submit_deliverable` is called inside the
   child session (`run-policy.mjs:767-775` enforces child ownership). It never appears in
   the root transcript, so `proof.submissions` is empty for a delegated deliverable — even
   though the projection recorded `rejected, attempts 2, gateRuns 2`.
2. **`proof.delegates` only fills when the delegate call *returns*.**
   `agentRuns.mjs:861` requires `result.ok`, and per §4 the call does not return until the
   child finishes. So during the 24m52s the child ran, `delegates` was empty too.

Result: all three items compute to `planned`/`attempts 0` → 「交付进度 0/3 · 待开始 ×3」,
for the entire life of the run, no matter what happens. This affects **adopted runs only**;
a dispatched run takes `agentRuns.mjs:2661-2663` and gets the real statuses.

### 6.2 Why `recordProgress` saw no child activity

Same function, same cause, plus a deliberate design rule.

`recordProgress` (`agentRuns.mjs:4539-4662`) can reset the stall counter from exactly two
sources — its return at `agentRuns.mjs:4661` is `!stillByHistory || !stillByKernel`:

- **root session history** (`stillByHistory`, `agentRuns.mjs:4632`) — frozen, because the
  parent is blocked inside one `evimed_delegate` tool call (§4);
- **kernel-attributed activity** (`stillByKernel`, `agentRuns.mjs:4634`) — either the event
  pump's `onRunActivity` (`agentRuns.mjs:4570`) or confirmed child session heads.

`stillByRunSide` — the run's own projection, which *was* changing — is computed
(`agentRuns.mjs:4633`) and written into the ledger `progress` event
(`agentRuns.mjs:4650`) but is **deliberately excluded from the return value**. The comment
at `agentRuns.mjs:4658-4660` states the reason: "it is a workspace document the model can
influence. Only root history or an authenticated DSH event may reset the stall counter."
That is a defensible integrity rule, and it is why a false stall is possible at all.

The child-head path then fails for adopted runs for the same reason as §6.1:
`readRunSideActivity` (`agentRuns.mjs:4434-4437`) takes `childSessionIds` from
`projection.subagents`, and for a native run `scopeNativeProjection:903-904` filters
`subagents` to those whose `deliverableId` is in `proof.delegates` — which is empty while
the child runs. So `childSessionIds` is empty, `readChildSessionActivity` is never called
(`agentRuns.mjs:4573`), `childActivity` stays `[]`, and `childAdvanced` is false.

A second, independent failure point exists in the same chain even when `childSessionIds`
is non-empty: `childSessionHeads` (`apps/server/src/runtimeManager.mjs:5239-5248`) requires
the kernel's `session/list` summary to carry **`origin === "subagent"`** and a matching
`parentSessionId`; any entry that does not is silently dropped. Whether the pinned kernel
emits those fields for a delegated child is **not determined** from this repo (it would
need a live `session/list`).

That leaves `onRunActivity` from the event pump (`apps/server/src/dshEventPump.mjs:805-808`)
as the only remaining resetter. It fires for a child session only if that session is in
`state.childSessions`, which is populated by a `subagent/started` event
(`dshEventPump.mjs:790-800`) or an `api-session/added` host frame
(`dshEventPump.mjs:638-656`). Whether the pinned kernel emits either for a socket-started
subagent is **not determined**; the empirical answer from F4 is that nothing reset the
counter for 15 minutes.

### 6.3 The notice itself

`agentRuns.mjs:4719`:

> 这次运行已有约 N 分钟没有可观测的进展（没有新消息、没有新工具调用、**工作区也没有变化**）。

The parenthetical asserts three things. The first two are measured (`stillByHistory`).
**The third is never checked** — nothing in `recordProgress` looks at workspace mtimes or
file counts, and the one signal that *is* about the workspace (`stillByRunSide`) is
explicitly excluded from the decision. The notice was false on all three counts in F4 and
was shown to the user as fact.

Threshold: `agentRunMonitorStallMs` 900000 ms, counted in 500 ms poll *rounds* rather than
wall clock (`docs/REQUEST_PATH.md` §4.2 C6, `apps/server/src/config.mjs:786-788`).

### 6.4 What a live, medically meaningful progress view needs

Today's ladder, in order of reliability:

| Signal | Producer | Reaches the browser? |
|---|---|---|
| `run/event` (every kernel event, attributed) | `dshEventPump.mjs:811` | `GET /api/runs/:id/events` — yes |
| `subagent/update` (child turn ended) | `dshEventPump.mjs:822-828` | yes |
| `evidence/update`, `budget/update` | `agentRuns.mjs:4468-4469` | yes, debounced on content |
| `deliverable/update` (one frame per changed deliverable, with issues) | `agentRuns.mjs:4504-4515`, shaped by `deliverableFrames` (`agentRuns.mjs:2792-2838`) | yes — **but the runs page does not subscribe**; it polls `planItems` instead (§6.1) |
| ledger `progress` (messages, toolCalls, runSideActivity, kernelActivity) | `agentRuns.mjs:4644-4652` | via the runs list |
| `compaction` | `dshEventPump.mjs:813-819` | yes |

So the wiring is largely there and **the highest-fidelity channel is unused by the page
that most needs it**. Fix order:

1. Subscribe `RunsPage` to `deliverable/update` instead of (or in addition to) polling
   `planItems`. Size S, no new events.
2. Fix `scopeNativeProjection` so an adopted run's item status comes from the projection
   when the run is still going, rather than from a root transcript that structurally
   cannot contain a child's submissions. Size S, high value: it repairs §6.1 *and* §6.2
   at once.
3. Derive the medical phases **from tool events already on the wire**, never from an
   enforced state machine (principle 12; the retired routers and mode presets stay
   retired). Every phase name below is a *label on observed tool calls*, computed in the
   browser from the `run/event` stream:

| Phase shown | Derived from (existing tool names, `toolNames.mjs`) |
|---|---|
| 检索 | `literature_search`, `guideline_search`, `clinical_trial_search`, `biomedical_source_search` |
| 筛选 | `evimed_screen_batch`, `evidence_deduplicate` |
| 全文获取 | `open_access_full_text`, `official_page_fetch` — count preserved artifacts |
| 证据提取 | *does not exist as a tool today* — this is the gap §1.4's `evimed_claim_upsert` fills |
| 撰写 | `write`/`edit` on `deliverables/<id>/*.md` |
| 逐条核验 | `evimed_claim_upsert` / `evimed_package_check` (proposed) or `evimed_review_run` |
| 交付 | `evimed_submit_deliverable`, `evimed_complete_run` |

Four of the seven phases are already observable with zero new instrumentation. The two
that are not — 证据提取 and 逐条核验 — are exactly the two that §1 shows happening inside
opaque `bash python` calls. **Adding the claim tool is the same change as adding the
progress view**; that is the strongest argument for doing it first.

Note that nothing here enforces an order. A run that answers a simple question with no
search shows no phases at all, which is the correct behaviour (principle 12).

---

### 6.5 The run event stream has no consumer in the frontend

`GET /api/runs/:id/events` exists (`apps/server/src/server.mjs:3322-3326`), is the
documented replacement for the retired kernel pass-through (`server.mjs:3240`: "Subscribe
to GET /api/runs/:id/events instead"), and is the whole point of the architecture guardrail
in `AGENTS.md` — "`apps/server` decodes the kernel's events into `@evimed/domain`'s
`RunEvent` and forwards its own stream ... so a kernel change is not a frontend change."

**A repo-wide grep of `apps/web/src/` finds no `EventSource`, no `/api/runs/` fetch, and no
subscriber of any kind.** The only match for `EventSource` is a test helper's type
annotation (`RuntimeUiFrame.test.tsx:35`).

So every event this audit has traced — `run/event`, `subagent/update`,
`deliverable/update` with its gate issues, `evidence/update`, `budget/update`,
`compaction`, `approval/requested`, `question/requested` — is produced, attributed,
debounced, published, and read by nobody. The live session surface is the **kernel's own UI
in an iframe** (`apps/web/src/app/routes/SessionRoute.tsx:94` → `RuntimeUiFrame`), which is
why F1–F3 are all about kernel locale keys and kernel panels, and why F4's researcher saw
「深度求索中... 26分53秒」 and nothing else.

This reframes §6.4: the work is **not** to build a progress view from scratch. It is to
consume a stream that is already correct, already attributed, and already carrying five of
the seven medically meaningful phases. It also explains why the two defects in §6.1/§6.2
survived — the only surface that reads deliverable status at all is a poll of a projection
that happens to be scoped wrongly for the adopted path.

---

## 7. Medical-expertise levers

### 7.1 The MCP surface is 34 tools, and the docs say 26

`runtime/mcp/evimed-research/server.py:266` holds 27 literal `TOOL_DEFINITIONS`, plus 7
appended from `science_connectors.tool_definitions()` at `server.py:792` = **34**.
`packages/domain/src/toolNames.mjs:38` says "The 26 research tools" while listing 34 at
`:42-86`; `AGENTS.md`/`CLAUDE.md` repeat the stale number.

Groups: retrieval (`literature_search`, `guideline_search`, `clinical_trial_search`,
`patent_search`, `biomedical_source_search`); preservation (`open_access_full_text`,
`official_page_fetch`, `web_search`); normalisation (`term_normalize`,
`drug_term_normalize`, `evidence_deduplicate`, `data_source_catalog`); pharmacy
(`drug_label_search`, `pharmacy_reference_search`, `adr_case_query`,
`adr_signal_analysis`); deterministic compilers (`offlabel_evidence_packet`,
`comprehensive_drug_evaluation`, `drug_selection_evaluation`); six managed specialist jobs;
seven generic science connectors; `geo_visibility_probe`; `health`.

**Prefill cost measured**: descriptions alone 5 977 chars; the full `tools/list` payload
**38 224 chars ≈ 10 K tokens**. It is top-heavy: `offlabel_evidence_packet` (4 056),
`comprehensive_drug_evaluation` (4 776), `drug_selection_evaluation` (3 889) and
`mendelian_randomization` (4 191) are **4 of 34 tools and 44% of the whole surface** —
almost all of it schema, not description.

**And the parent sees all of them.** `toolNames.mjs:123-130` defines
`ROOT_VISIBLE_MCP_BASE_NAMES` (5 umbrella tools) and re-exports it at
`packages/domain/index.mjs:41`, but **a repo-wide grep finds zero consumers** — it is a dead
export. No `toolFilter` is ever set for a root session (the filter appears only in the
delegation path, `packages/socket/plugins/run-policy.mjs:639` →
`packages/harness-port/index.mjs:567`). So the orchestrator carries ~10 K tokens of tool
schema for tools it will never call, on every request, for the life of the run. **Wiring
the existing constant is the single cheapest first-turn saving available** (§2) and it is a
one-line change to code that is already written.

Children *are* filtered: `delegationToolFilter` (`packages/domain/src/capabilityManifest.mjs:322-331`)
= `DELEGATION_BASE_TOOLS` (`:39-54`) ∪ `manifest.tools`. `meta-analysis` gets exactly one
MCP tool; `clinical-evidence-synthesis` gets nine.

### 7.2 What is actually reachable — and the one that is not

The catalogue is 123 entries (`runtime/mcp/evimed-research/source_catalog.json`), of which
`public_sources.py:3403-3419` exposes **62 keyless** sources and `:3421-3424` eight
credentialed ones.

**Seven of those eight credentials are unconfigured in production** — the banner F7 saw.
From `packages/domain/src/connectorCredentials.mjs:28-95` (11 connectors, 3 keyless) minus
what `.evimed-local/deploy/evimed-production.env` actually sets (materials-project only):
**`opengwas`, `core`, `unpaywall`, `umls`, `omim`, `addgene`, `biogrid`**.

**The most serious consequence is not on the list of things anyone is watching: the
non-PMC full-text path is dead.** `apps/server/src/publicSourceGateway.mjs:709-712` throws
`503 public_source_unpaywall_credential_missing` **before any lookup**, so
`open_access_full_text`'s DOI→PDF route (`open_access_fulltext.py:276-325` →
`public_sources.open_access_pdf_bytes`) never runs. Today the full-text path is
**PMC-only**: a paper with a DOI but no Europe PMC copy returns `full_text_not_available`
and therefore **cannot carry a claim** (`SKILL.md:1102`: "then you have not read that
source and it cannot carry a claim"). That is a direct, measurable ceiling on evidence
quality, fixed by adding one email address to a credentials file.

Two more narrowings worth naming:

- **Abstracts are fetched for only the top 5 PubMed hits** (`public_sources.py:35`
  `PUBMED_ABSTRACT_FETCH_LIMIT = 5`, used at `:2067-2070`); everything else is
  `_bibliographic_metadata_only` (`:1346-1357`). A screening step that reads titles only is
  exactly what `SKILL.md:1659` forbids ("every included source was inspected beyond
  title-only metadata").
- **`official_page_fetch` reaches 7 hosts**: `www.cochrane.org`, `www.acc.org`,
  `professional.heart.org`, `cpr.heart.org`, `www.nhs.uk` (one symptom page),
  `www.ccfdie.org`, `mpa.hunan.gov.cn` (`runtime/mcp/evimed-research/official_pages.py:18-26`).
  **No NICE, no NMPA, no CDE, no WHO.**

### 7.3 Chinese-language and drug-label assets are almost entirely unused

- `/home/coder/workspace/EviMedScience/药学基础数据/` is **referenced by path nowhere** in
  `OpenScience/`. The only coupling is `runtime/mcp/evimed-research/build_pharmacy_reference.py:25-48`,
  which names **22 CSV filenames** from `重点整理数据表/` and takes the directory as a
  build-time `--source-root` (`:186-190`). All 22 exist; the coupling is by filename
  convention and would break silently on a rename.
- That build is live: `.evimed-local/data/pharmacy-reference.sqlite`, 15.6 MB, 22 datasets,
  **10 929 rows**, served through `pharmacy_reference_search`
  (`public_sources.py:3001-3057`, SQLite FTS5 bm25, read-only). It is overwhelmingly TCM:
  `tcm-name-map` 6 708 rows, `tcm-route-dose` 821, `tcm-contraindication-toxicity` /
  `tcm-decoction` / `tcm-dose` 616 each. Western-drug tables are 7–57 rows each. Every row
  is stamped `evidenceAccess: "user_provided_other"` and warned as "not proof of a current
  label" (`:3037, 3047-3049`) — correct, and also the reason it cannot carry a claim.
- **`中医药数据/` and `药品说明书数据库_医药数据查询/` are referenced nowhere at all.** The
  eight `药品说明书数据库_医药数据查询(*).xlsx` files, `药品详细信息_总.xlsx`, TCMSP,
  中医方剂, 中草药 50000味 and 中药靶点 are entirely unused.
- **No Chinese guideline or literature registry is reachable.** CNKI (`source_catalog.json`
  index 25), 维普 (24), 万方 (116), SinoMed (115) and Cochrane Library (16) are all
  `blocked_license`; ChiCTR (1) and NMPA/CDE (103) are `blocked_no_api`; NMPA's local
  label library (102) is `ready_private_adapter` and needs a database nobody has built.
  NMPA labels exist only as a jurisdiction string on the EviMed private API
  (`public_sources.py:1270, 1278`).

**This is the largest unexploited medical asset in the workspace**, and the gap is
specific: a Chinese-language evidence product with a 10 929-row TCM reference it can only
cite as "user provided", no NMPA label source, and no Chinese guideline registry.

### 7.4 Normalisation and appraisal: nothing infers, everything declares

- **MeSH**: exists only as an NCBI E-utilities *database id* (`public_sources.py:2104,
  3405, 3445`) and as incidental ids from PubTator3 (`:625`). **No tree expansion, no
  query mapping, no normalisation.**
- **ATC**: **no normalisation anywhere.** Mentions are prose plus one blocked catalogue row
  (`source_catalog.json:2133`, WHO ATC/DDD, `blocked_license`).
- **UMLS**: unconfigured (§7.2), so `term_normalize` falls back to `TERM_VOCABULARY`
  (`server.py:820-828`) — **seven entries**: paracetamol, aspirin, myocardial infarction
  and their CN/EN aliases.
- **PICO**: no extractor. `pico`/`picoMatch` are matrix *fields the model fills in*
  (`SKILL.md:1122-1138`); nothing derives them from a record.
- **Study design**: a closed vocabulary the model fills in —
  `packages/domain/src/appraisalContract.mjs:109-122` (13 designs), `:128-136`
  (observational). Validation refuses an off-vocabulary word (`:415-421`). **No classifier.**
- **RoB / ROBINS-I / Jadad / Newcastle-Ottawa / AMSTAR 2 / QUADAS-2 / AGREE II / Naranjo /
  WHO-UMC**: two closed vocabularies, both declarative —
  `runtime/mcp/evimed-research/drug_assessment.py:57-68` (enum the model reports into) and
  `packages/domain/src/clinicalEvidence.mjs:567-580` (11 regexes that detect an instrument
  was *named*). **No instrument is ever executed.**

### 7.5 GRADE is prose plus two advisory arithmetic checks

The model performs the ladder in prose (`capabilities/evidence-appraisal/SKILL.md:136-152`:
`certainty` = start − downgrades + upgrades, floored at `very-low`), and the SKILL says so
plainly: "**Not a certified GRADE assessment**, and not a certified run of any instrument"
(`:161-163`); "It does not pool effects" (`:253-254`).

Two deterministic layers check consistency and **neither can block**:

1. `packages/domain/src/appraisalContract.mjs` recomputes start − downgrades + upgrades and
   refuses a stated certainty that disagrees (`:593-641`), refuses a `high` start for an
   all-observational body (`:620-628`) and a `low` start for an all-RCT body (`:629-635`).
   Wired at `contractRegistry.mjs:668`. **Every finding is advisory by construction** —
   `appraisalContract.mjs:24-35`: "The blocking budget is six system-wide and it is spent."
2. `clinicalEvidence.mjs:731-803` `declaredAppraisalIssues`: an instrument declared in
   `资料与方法` and never applied, and `grade-level-contradicts-downgrade` (`:785-800`) — a
   paragraph asserting a deficiency while handing down 高 certainty. Advisory: not in
   `CLINICAL_CHECK_TIERS` (`:417-436`). The author's own measurement for keeping it
   non-blocking is at `:550-562` — blocking over thirty packages rejected twenty-nine, of
   which read-through confirmed three.

**No component ever assigns a GRADE level or a risk-of-bias rating.**

### 7.6 The safety rules are two medicines deep

`packages/domain/src/clinical-safety-rules.json` (`schemaVersion: 1`):

- **`rules`: 4**, all about one scenario — 速效救心丸 / 硝酸甘油 / chest pain. Kinds:
  `medication-response-not-diagnostic`, `unsupported-self-care`,
  `medicine-absent-from-question`, `suxiao-must-not-delay-emergency`. The first regex is
  ~1 200 chars of negation lookbehind. Tier `safety` (`clinicalEvidence.mjs:430`), which
  **does** withhold delivery (`:3481-3488`).
- **`routingEntities`: 2 strings** — `速效救心丸`, `Suxiao Jiuxin Wan`. Naming one routes an
  open-domain question into `clinical-evidence-synthesis` so the gate applies.
- **`highRiskEntities`: 142 strings** (~60 distinct medicines with CN/EN aliases:
  硝酸甘油, 肾上腺素, 阿托品, 胺碘酮, 地高辛, 华法林, 肝素, 利伐沙班, 氯吡格雷, 阿司匹林…).
  Advisory only, by the file's own note.

The file is exactly the right shape — data a pharmacist edits without touching code — and
it is **two medicines deep and one scenario wide**. F4's own question was aspirin primary
prevention in the over-70s, which touches `阿司匹林` (advisory only) and no rule at all.
Growing this file is the highest-leverage medical-expertise work in the repo and requires
no engineering: it is the one place where domain expertise converts directly into product
behaviour (principle 7: priors live in context, not control flow — and this file is the
data form of that).

### 7.7 Specialist engines: all six wired, and one capability does statistics without one

All six resolve: `mendelian-randomization`, `bibliometric-analysis`,
`research-topic-selection`, `peer-review`, `drug-safety-analysis`
(`runtime/mcp/evimed-research/specialist_jobs.py:42-111`, mirrored in
`deploy/specialist-adapter/evimed_specialist_adapter/service.py:40-111`) and
`meta-analysis` through its own `meta_agent.py`.

| engine tool | capabilities that declare it |
|---|---|
| `meta_analysis` | `meta-analysis` (its **only** tool) |
| `mendelian_randomization` | `mendelian-randomization` |
| `bibliometric_analysis` | `bibliometric-analysis`, `research-topic-selection`, `dataset-research-scoping` |
| `research_topic_selection` | `research-topic-selection`, `research-grant-development`, `dataset-research-scoping` |
| `peer_review` | `peer-review` |
| `drug_safety_analysis` | `adr-analysis` |

`adr-analysis` additionally gets a deterministic statistic outside the engine:
`public_sources.py:1745-1858` computes the FAERS 2×2, ROR + 95% CI, PRR + 95% CI,
Yates-corrected χ², crude IC and the EVANS flag, refuses EBGM (`:1822-1823`) and refuses to
estimate with a zero cell (`:1819-1820`). That is the model of what §1.4 asks for, applied
to statistics rather than to citations.

**`evidence-appraisal` is the outlier**: it performs the GRADE ladder arithmetic in the
model with only an advisory recomputation behind it (§7.5). `clinical-evidence-synthesis`
computes derived numbers in-model with `derived-claim-inputs` (blocking,
`clinicalEvidence.mjs:426`, enforced `:3160-3178`) requiring `derivedFrom` ids and a
`method` ≥40 chars — but **nothing recomputes the number**.

### 7.8 High-value medical assets NOT used today

| Asset | Status | Effort |
|---|---|---|
| Unpaywall credential → the whole non-PMC OA full-text path | unconfigured; a hard 503 | **XS** — one email in a credentials file |
| `药品说明书数据库_医药数据查询/` (8 xlsx + 药品详细信息_总) — structured Chinese drug labels | referenced nowhere | M — a build script like `build_pharmacy_reference.py` already exists as the template |
| NMPA local label library (`source_catalog.json` index 102, `ready_private_adapter`) | adapter never built | M |
| Chinese guideline registry (CNKI/万方/维普/SinoMed all `blocked_license`) | unreachable | L — licensing, not engineering |
| MeSH tree expansion for query building | absent | M — NCBI E-utilities already reachable keyless |
| ATC normalisation | absent | M — WHO ATC/DDD is `blocked_license`; RxNorm is already wired via `drug_term_normalize` |
| PICO extraction from a retrieved record | absent; fields are hand-filled | M — the fields and their validation already exist |
| Study-design classification from methods text | absent; vocabulary exists | M |
| RoB / AMSTAR / Newcastle-Ottawa executed rather than named | absent | M–L, and the highest medical-credibility return |
| `中医药数据/` (TCMSP, 中医方剂, 中草药 50000味, 中药靶点) | referenced nowhere | M |
| `clinical-safety-rules.json` beyond one scenario | 4 rules, 2 routing entities | **S per rule, and it is pharmacist work, not engineering** |

---

## 8. Model strategy

### 8.1 One model, one effort level, for everything

`apps/server/src/modelGateway.mjs:11-17` allows four ids — `deepseek-flash`,
`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro` — and
`config.deepseekModel` (`apps/server/src/config.mjs:921-922`, shipped as `deepseek-flash`
in `deploy/web/.env.example:259`) picks one for the whole deployment. There is no
`thinking`/`reasoner` model id; thinking is a per-request flag.

The gateway then **overwrites whatever the caller asked for**
(`modelGateway.mjs:328-337`):

```js
return { ...body, model: config.deepseekModel, thinking: { type: "enabled" },
  reasoning_effort: config.deepseekReasoningEffort ?? "high", stream, ... }
```

So every request in the system — the parent's planning turn, a child's 190-step research
loop, the routing classifier, the memory extractor, the `review` verifier, the learning
judge — runs on the same model at `reasoning_effort: high` with thinking enabled. **There
is no per-role tiering anywhere.** Three levers exist and all three are dead:

- `dispatchPrompt` is called with `model: \`deepseek/${config.deepseekModel}\``
  (`apps/server/src/server.mjs:1235, 1892, 1980, 2819`) but
  `dispatchAdmittedPrompt` does not destructure `model`
  (`apps/server/src/runtimeManager.mjs:3870`), so it is **silently dropped** and never
  reaches `session/create`. It survives only as a ledger label (`agentRuns.mjs:2934`).
  (`agent` is dropped the same way; the preset is hard-coded at `runtimeManager.mjs:3902`.)
- The kernel's `subagent-model-selection-settings` row is present and not disabled
  (`deploy/runtime-dsh/dump-config.baseline.json:387-388`), but the profile patch writes a
  one-entry `models:` list (`apps/server/src/dshProfilePatch.mjs:134-136`), so there is
  nothing to select between.
- `evimed_delegate` takes **no** model or effort parameter — its three parameters are
  `deliverableId`, `brief`, `inputs` (`packages/socket/plugins/run-policy.mjs:599-603`),
  and `SubagentRequest` has seven fields, none of them a model
  (`packages/harness-port/src/types.mjs:81-89`, `packages/harness-port/index.mjs:560-570`).

`reasoning_effort` (`low|high|max`, default `high`, `config.mjs:44-53, 929-931`) is the one
live lever and it is global.

### 8.2 The cost decomposition confirms the diagnosis

Price list `packages/domain/src/metering.mjs:172-182` (CNY per million tokens,
`deepseek-flash`): cacheHit **0.04**, cacheMiss **2**, output **8**. Off-peak multiplier
0.5 (`metering.mjs:50-69`).

Applying it to F4's measured counts:

| term | tokens | rate | peak CNY | share |
|---|---|---|---|---|
| cache-hit input | 73.1 M | 0.04 | 2.924 | **44.2%** |
| cache-miss input | 0.73 M | 2 | 1.460 | 22.1% |
| output | 0.278 M | 8 | 2.224 | 33.7% |
| | | **total peak** | **6.608** | |
| | | ×0.5 off-peak | **3.304** | |

Measured bill was **¥3.31** — a 0.2% match, confirming the run executed entirely off-peak
and that the price list is accurate. **The single largest line item is the cheapest
per-token one, purely by volume.** Cutting carried context, not switching models or
trimming output, is the lever. (Same run on `deepseek-v4-pro` would be ¥36.0 peak — 5.45×.)

### 8.3 Cost controls that cannot work as written

- **The reservation estimate is ~250× the real cost.** `estimateModelReservation`
  (`modelGateway.mjs:341-349`) uses `Buffer.byteLength(JSON.stringify(messages))` **as a
  token count**, caps it at 1 000 000, and prices all of it at the cacheMiss rate. At a
  320 K-token context that reserves ≈¥2.52 per request against an actual ≈¥0.0099. Any
  operator who sets a real daily cap will see runs refused at ~1/250 of their true spend.
  All caps currently default to `0` = no cap (`config.mjs:724-729`,
  `deploy/web/.env.example:64-68`), which is the only reason this is not already breaking.
- **No per-run token ceiling is enforced.** `runMaxSteps`/`runMaxTokens` default to `0`
  (`config.mjs:799-800`), `integer(0, 200)` returns `0` rather than the fallback
  (`dshProfilePatch.mjs:629-632`), and the in-run guard requires `maxTokens > 0`
  (`packages/socket/src/runPolicy.mjs:153-155`). The shipped `.env.example` sets neither.
- **An unmetered second egress exists.** `SpecialistClassifier` is constructed with no
  usage ledger (`server.mjs:1075-1077`) and calls `api.deepseek.com` directly with the
  deployment key (`specialistClassifier.mjs:139-146`). It never reserves, never settles,
  never appears in `model_requests`, and account caps do not apply — which is exactly the
  defect `callModelForControlPlane`'s own docstring says it exists to prevent
  (`modelGateway.mjs:624-646`). It fires on every turn the regex router misses and is on
  by default (`config.mjs:936-937`).

### 8.4 Reliability knobs

- **Temperature/top_p are never set** by the gateway (`modelGateway.mjs:328-337` overrides
  only model/thinking/effort/stream/max_completion_tokens) nor by the profile patch
  (`dshProfilePatch.mjs:128-141`). The runtime's effective temperature is
  `@deepseek-ai/dsh-llm-deepseek`'s default — **not determined** from this repo. The two
  control-plane callers that build their own body both pin `temperature: 0`
  (`specialistClassifier.mjs:149`, `memoryIntelligence.mjs:925`).
- **No strict tool schemas.** `strict` is validated (`modelGateway.mjs:270`) but never set
  anywhere in `packages/socket` or `packages/harness-port`. `parallel_tool_calls` is
  likewise validated (`modelGateway.mjs:305-307`) and never set — relevant to §4, since
  parallel delegation would want it on.
- **No retry at the gateway.** A 429 or any non-2xx is mapped and thrown
  (`modelGateway.mjs:518-528`); `callModelForControlPlane` does not retry either
  (`:691-694`). The only retry is the upstream `@deepseek-ai/dsh-llm-retry` row
  (`dump-config.baseline.json:54-55`) which carries no config — policy **not determined**.
- The only application-level retry is the most expensive one possible: a child that does
  not reach `completed` is **re-delegated once from scratch**
  (`packages/socket/src/runPolicy.mjs:687-694`, driven at `run-policy.mjs:705-741`) — a
  full re-run of a 25-minute deliverable.

### 8.5 The `review` plugin

`packages/socket/plugins/review.mjs` registers `evimed_review_run` (`review.mjs:71-112`):
a **fresh-context** subagent with a verifier persona, grounding tools the original reasoner
did not have (`read, glob, grep, literature_search, open_access_full_text,
official_page_fetch`, `review.mjs:93`), `maxDepth: 1`, `maxClaims` default 40
(`review.mjs:32-35`). It returns `{ verdicts, blocking: false }` (`review.mjs:110`) —
advice only, on by default (`config.mjs:825`), invoked only when the model calls it, and
the guidance tells it to call it before the first submit because submission freezes files
(`packages/socket/src/guidanceText.mjs:114`).

Its own module header is the best-argued piece of gate discipline in the repo
(`review.mjs:4-14`): 129 findings over 29 deliveries, 114 surviving code verification,
**3** landing on a human annotation; five runs of the same input at temperature 0 produced
6/4/4/3/4 findings with *different accusations each time*. That is why it is advice.

Cost caveat: a fresh context means **zero prefix-cache reuse**, so the review child's input
tokens land in the ¥2/M miss column rather than ¥0.04/M. Its per-run cost is not separately
metered — **not determined** as a figure.

### 8.6 What per-role tiering would be worth

Not a recommendation to switch models globally — a recommendation to make the lever exist
and then measure it (principles 11 and 20). The natural split, given §1 and §8.2:

| role | today | candidate | rationale |
|---|---|---|---|
| parent planner (2 plan calls, 1-2 delegates) | flash, effort high | flash, effort **max** | ~5 requests per run; the plan's `dependsOn` graph is where §4's error happened |
| child researcher (190 steps) | flash, effort high | flash, effort **low** for mechanical steps | 335 requests; thinking on every `read` of a file slice is pure cost |
| routing classifier | flash, effort high (bypasses the gateway, so effort is *not* applied) | unchanged, but **routed through the gateway** so it is metered | §8.3 |
| memory extractor | flash, temperature 0 | unchanged | already measured: 22 s flash vs 38 s pro |
| `review` verifier | flash | **pro** is the one defensible upgrade | it is the only role where a second opinion's quality is the whole point, it runs once, and it is bounded at 40 claims |

The blocker for all of these is the same one line: `runtimeManager.mjs:3870` does not
destructure `model`, and `evimed_delegate` has no model parameter. Until a model can be
chosen per role, no tiering experiment can even be run.

---

## 9. Reliability & state

### 9.1 What is in memory only, and what a restart costs

`AgentRunStore`'s constructor (`apps/server/src/agentRuns.mjs:2950-3016`) holds thirteen
process-local Maps. The load-bearing ones:

| Field | Line | Loss consequence |
|---|---|---|
| `dispatchedBriefs` (runId → **full brief text**) | `:3016` | the gate loses the question-scoped safety rule |
| `clinicalRepairAttempts` / `…Structural…` | `:3003, 3005` | **repair budget refills** |
| `clinicalRepairSenders` (closures re-prompting the kernel) | `:3007` | receipt-resubmission path dies (`:4200`) |
| `kernelActivities` / `childKernelHeads` | `:2956-2960` | stall baselines reset |
| `dispatchOwners` | `:3002` | every in-flight dispatch becomes `dispatchStatus: "unknown"` |

The brief is kept out of the ledger deliberately — the ledger is capped at 1 MiB
(`agentRuns.mjs:71`) and only a truncated question preview is stored
(`:158-162`). The workspace copy `.evimed-brief/research-brief.md` is advisory only:
`agentRuns.mjs:1049-1053` and `:3576-3582` state that "the delivery gate reads the
server's in-memory copy and never this one."

**The consequence is named in the code and is a medical-credibility issue, not a
bookkeeping one.** After a restart the gate runs with `brief = null`
(`agentRuns.mjs:4005-4008`), pushes an advisory, and records
`skippedChecks.push("question-scoped-safety-rules")` → `verification: "unchecked"`
(`:1769`). The comment at `agentRuns.mjs:181-196` explains why that third verification
value had to be invented: *"Losing the exam paper made the grade go up."*
`clinical-safety-rules.json`'s drug/scenario rules are matched against the dispatched
question, so a control-plane restart mid-run **silently disables the pharmacist-authored
safety layer** for that run. A durable brief (a 0600 sidecar keyed by run id, outside the
capped ledger) removes this entirely. Size S.

**The monitor does resume.** `adoptRunningRuns` (`agentRuns.mjs:5077-5101`) walks every
project at startup and re-schedules a monitor for every `running` run, awaited before
`server.listen` (`server.mjs:3769`). A resumed monitor's first `reconcileSession` gets
`runtime_not_running` and crosses `finishFromDurableRecord` (`:3919-3937`) — the receipt
and projection decide, not the dead container. Two residual holes:

- If `listStoredProjects()` or `cleanupOrphanedRuntimes()` throws, the whole block is
  caught at `server.mjs:3494-3505` and `adoptRunningRuns` is **never reached**; every
  in-flight run stays `running` with no monitor and no retry (`runStartupRuntimeCleanup`
  memoizes its own promise at `:3483`).
- The 4-hour ceiling restarts: `monitorMaxPolls` is a per-monitor loop counter
  (`agentRuns.mjs:4683`), so a run restarted at 3h55m gets a fresh 4 hours.

### 9.2 There is no cancel

**No `/api/agent-runs/:id/cancel` route exists.** The `/api/agent-runs/*` surface is
`GET` (`server.mjs:2620`), `/repair-revisions` (`:2633, 2642`), `POST /dispatch` (`:2659`)
and `POST /:id/steer` (`:2839`). `/api/tasks/:id/cancel` (`:3186`) is the shell-task
manager, not runs. `apps/web/src/app/routes/RunsPage.tsx` has no cancel control — only a
`canceled` label (`:77`) and a filter (`:436`).

The three real cancel entry points are: the kernel's `POST /session/:id/abort` through the
runtime-UI proxy (which is **off by default** — `OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED=`
empty in `deploy/web/.env.example:309`), autopilot (`server.mjs:1776-1799`) and
source-understanding (`sourceUnderstandingRuntime.mjs:281-284`).

`cancelSession` (`agentRuns.mjs:3861-3883`) cancels the monitor and finishes the run
`canceled` / `runtime_canceled`. It does **not** cancel child sessions —
`runtimeManager.cancelRuntimeSession` (`:3823-3836`) issues one `session/cancel` for the
named session only, and whether the pinned kernel cascades to subagents is **not
determined**. It does **not** stop the container either; only `endBoundedRuntime`
(`runtimeManager.mjs:2914-2920`) does, and only for bounded runtimes.

**Partial work is kept**, and this is well built: `finishInternal` (`agentRuns.mjs:3749`)
is one funnel for every terminal path, and when the status is not `succeeded` with an empty
`artifacts` it re-reads the workspace and lists what it finds under `unverifiedArtifacts`
plus `UNVERIFIED_DELIVERY_NOTICE` (`:3800-3810`). The comment records the defect it fixed:
28 of 179 finished runs ended gate-refused with `artifacts: []` at p90 58 minutes while
every file was on disk.

So: a researcher who realises at minute 3 that the run is going the wrong way has **no way
to stop it**, and no way to redirect it either (`/steer` exists server-side with no web
call site, §5.3). That is the second-largest pure-UX gap after §5.3, and both are fixed by
wiring buttons to endpoints that already exist.

### 9.3 Runtime slots and reaping

| Key | Default | `.env.example` |
|---|---|---|
| `maxRunningRuntimes` (`config.mjs:717`) | 8 | `:467` = 8 ✅ |
| `maxRunningRuntimesPerUser` (`config.mjs:737-739`) | 4 | `:468` = 4 ✅ |
| `runtimeIdleTimeoutMs` (`config.mjs:689-691`) | 30 min | `:462` ✅ |
| `agentRunMonitorTimeoutMs` (`config.mjs:706-708`) | 4 h | **absent from `.env.example`** |

Enforced by `enforceRuntimeCapacity` (`runtimeManager.mjs:4083-4095`) as a
`429 runtime_limit_exceeded` with `Retry-After: 5` (`security.mjs:239-241`) and a Chinese
message from the domain registry (`errorCodes.mjs:784`). The idle reaper sweeps every 60 s
(`runtimeManager.mjs:4679-4704`, scheduled at `server.mjs:3714`), asks the kernel
`session/list`, and treats **unreadable as not idle** (`:4692-4697`).

**A sharp edge in the dispatch path.** The run row is reserved (`agentRuns.mjs:3388`)
*before* `sendPrompt` reaches `startAdmitted`. A `runtime_limit_exceeded` is not
`definitivelyRejected`, so the catch takes the else branch —
`markDispatch(id, "unknown")` + `scheduleMonitor` (`:3418-3420`) — and then rethrows the
429. **The user gets a 429 and a run row simultaneously stuck in `running`/`unknown`**, and
`agent_run_active` (409, `:3279-3281`) then refuses their retry on that session until the
placeholder settles. This is the mechanism behind the memory note "runtime slot is one and
nothing reaps it" and "dispatch refuses past two runtimes per user".

### 9.4 `model_requests.run_id` is NULL by construction, not by accident

The run id travels as a **JWT claim in the model-gateway runtime token**, and that token is
minted **per runtime (per project), not per run**:

1. `createModelGatewayHandler` verifies the bearer and gets `caller`
   (`modelGateway.mjs:474` → `runtimeManager.mjs:2699-2712`).
2. The reservation writes `runId: caller.runId ?? null` (`modelGateway.mjs:486`).
3. `issueModelGatewayRuntimeToken` adds `runId`/`dailyLimit`/`weeklyLimit`/`runLimit`
   **only when `budgetScope` is non-null** (`runtimeManager.mjs:1252-1260`).
4. `budgetScope` comes from `pendingModelGatewayScopes`, written **only** by
   `reserveBoundedRuntimeSession` (`runtimeManager.mjs:2892-2912`).
5. That function has exactly four callers, all non-interactive: autopilot episodes
   (`server.mjs:1926`), autopilot verification (`:1859`), learning
   (`learningRuntime.mjs:200`), source understanding (`sourceUnderstandingRuntime.mjs:153`).

And bounded and interactive runtimes are mutually exclusive
(`assertInteractiveRuntimeAvailable` throws 423 `runtime_reserved_for_autopilot`,
`runtimeManager.mjs:2886-2890`). **So an ordinary user-dispatched run structurally cannot
carry a run id.**

Visible consequences: `GET /api/runs/:id/usage` (`server.mjs:3298-3320`) returns zeros for
every interactive run — its own comment ("keyed by `dispatchId`, which is what the gateway
stamps on each call") is true only for bounded runtimes. And the `runLimit` per-run cap
(`usageLedger.mjs:174`) requires `runLimit > 0 && runId != null`, both of which are false
for interactive runs, so **it has never fired**. This is also why every ablation report
says cost is "unavailable" (§10.6) — the evals cannot price their own arms.

The smallest fix uses machinery that already exists: `issueModelGatewayBudgetMarker`
(`modelGateway.mjs:63-73`) already embeds a signed `runId` in the prompt text and
`consumeBudgetScope` (`:98-128`) already strips and verifies it — but `:119-121` rejects the
marker unless `caller.runId` already equals it, i.e. it is a cross-check and cannot be a
source. Relaxing that one line (accept the marker as the source when the token has no
`runId`) attributes every interactive run, at the cost of moving the run id into
model-writable context. Alternative: rotate the container's `model-gateway.token` file per
run (written once at start today, `runtimeManager.mjs:1900-1901`). Either is size S–M.

### 9.5 Submit idempotency

`entry.attempts` is a `Map` on the plugin's per-session state **inside the container**
(`run-policy.mjs:245`), reset per ledger run (`:1205`), projected durably into the plan
index (`:1370-1377`), the run mirror (`:1356`), and one row per gate run at
`` store.gateRuns.put(`${runId}:${itemId}:${attempt}`, …) `` (`:1381-1384`).

**Bug:** that key uses `charged` (`:817-818`), which does **not** advance for
structural-allowance submissions — so two consecutive unreadable submissions write the
**same key** and the second silently overwrites the first's issue record. The
unreadable-submission history is exactly what the structural allowance was built to make
visible.

**Identical-content re-submit is not deduplicated** — no content hash is compared before
gating; `gateDeliverable` re-runs and the attempt is charged. What does exist: an accepted
deliverable's files are frozen by the path guard (`accepted_deliverable_frozen` on
write/edit and on shell `rm|mv|cp|sed -i|tee|truncate|install|dd|ln`,
`packages/socket/src/runPolicy.mjs:113, 136-142`), and acceptance is not revocable
(`run-policy.mjs:825-833`).

**What the model actually sees** is a *text projection*, not JSON —
`renderEnvelope` (`packages/harness-port/index.mjs:188-199`):

```
failed: <code>
- (required) <code> [<path>:<line>] <message>
- (advisory) <code> <message>
```

with advisory+optional bounded to 12 and a `more_suggestions` tail
(`packages/socket/src/runPolicy.mjs:379-408`; the measurement behind the bound is 34–111
findings on a first submission, 1–15 of them required). This matters for the memory note
"socket tool results are rendered text" — three server readers once parsed bare JSON here
and found nothing.

### 9.6 Adopted sessions differ in eight places

The durable mapping is the `sessionId` field on the ledger row
(`agentRuns.mjs:3334`); adoption is marked by `effectiveRouteReason` starting
`adopted:runtime-ui` (`:86-88`). Everything the event pump keeps
(`dshEventPump.mjs:133-147`) is in-memory and rebuilt from `noteRun`.

| Area | Dispatched | Adopted |
|---|---|---|
| Monitor | always scheduled (`agentRuns.mjs:3407`) | only if a contract was routed (`:4862`); otherwise **no monitor at all** (`:4864-4869`) |
| Verification | computed at the end | `"unchecked"` from the first event by design (`:4800-4814`) |
| Supersession | second dispatch refused `agent_run_active` (`:3279`) | placeholder cancelled `superseded_by_dispatch` (`:3273-3300`) |
| Deliverable projection | per-run file `runStateFileFor(run.id)` (`:2643`) | **shared** `runStateFile`, scoped by `scopeNativeProjection` → the §6.1 defect |
| Unattributed result | n/a | `specialist_deliverable_not_accepted` (`:3689`) or `verification:"unverified"` + a notice; child discovery returns empty (`:4418`) |
| Repair budget | in-memory | same maps — "how an adopted run silently gets a fresh repair budget" (`:3556-3558`) |

Given that the kernel's own UI is the live session surface (`SessionRoute.tsx:94`), the
**adopted path is the normal path for an interactive researcher** — and it is the path with
the weaker monitor, the weaker projection and the documented "unchecked" verification.
That inversion is worth naming as a product decision, not just a code detail.

### 9.7 Notifications carry raw validator prose because one line bypasses the mapping

Trace for `claims[52].claim numeric fact 6 is not present in its direct support`:

1. Built as a **plain string** (not a `GateIssue`) at
   `packages/domain/src/clinicalEvidence.mjs:3213` (siblings at `:2884, 2891, 3193, 3334,
   3349`). The server-side `validateClinicalEvidencePackage` path is a different shape from
   the socket gate's typed issues.
2. Classified as bookkeeping → non-blocking (`clinicalEvidence.mjs:1497`).
3. Spread into the verdict **unprefixed**: safety and blocking issues get `SAFETY — ` /
   `MUST FIX — ` (`agentRuns.mjs:2238-2241`); `rest` is spread as-is at `:2242`.
4. Into `qualityNotices` (`:4144, 4156, 4163`), normalised to ≤40 × ≤300 chars.
5. **`apps/server/src/notificationService.mjs:136`** puts the first two notices, each
   truncated to 200 chars, straight into the notification body with no translation, no
   grouping and no code mapping.

The fix already exists and is simply not called: `apps/web/src/lib/runPresentation.ts:213-226`
holds `NOTICE_GROUPS` including `{ label: "证据矩阵主张", match: /^claims\[\d+\]/ }`
(`:216`), and its own header comment (`:202-212`) names both the defect and the real fix:
*"making them visible put forty lines of English validator prose in front of a
Chinese-reading researcher … the real fix is the gate emitting a code plus parameters
instead of an English sentence."*

So there are two fixes at different depths: (a) have `runFinishedNotice` group and localise
through the same table the web UI uses — size S; (b) make `clinicalEvidence.mjs` emit
`{code, params}` on the server path as it already does on the socket path — size M, and it
is the one that makes every consumer (inbox, runs page, ledger, evals) speak the
researcher's language at once.

---

## 10. Memory

### 10.1 What is recalled and where it goes

Recall runs **unconditionally at every dispatch** — `apps/server/src/server.mjs:2758-2775`
(chat/deep) and `:1952-1959` (autopilot episodes). A throw becomes a *definitive run
rejection*, not a degraded answer (`memoryRecallRejection`, `server.mjs:590-597`).
Autopilot *verification*, learning and source-understanding runs pass `memories: []`
(`server.mjs:1879`, `learningRuntime.mjs:219`, `sourceUnderstandingRuntime.mjs:172`).

Shape: one `<evimed-memory index id type kind scope>` envelope per item
(`apps/server/src/researchContext.mjs:323-333`), assembled into the **root system prompt**
(`researchContext.mjs:359-365, 450-455`). Budget is **character-based, not token-based**:
`memoryContextLimit` default **8** items, `memoryContextMaxChars` default **20 000**
(`apps/server/src/config.mjs:1099-1104`), enforced by
`selectWithinBudget` (`apps/server/src/memoryRecallPolicy.mjs:49-95`). Token cost is
therefore **not determined** by design — roughly 7–13 K tokens for mixed zh/en at 20 K
chars, which is a material share of the ~55 K first turn (§2).

Empty recall is stated explicitly to the model
(「当前问题未检索到相关科研记忆；不要声称使用过科研记忆。」), which is good hygiene.

### 10.2 The two known defects are fixed

- **Episodes crowding out the profile: fixed.** `DURABLE_RECALL_KINDS`
  (`memoryRecallPolicy.mjs:19`) and `DURABLE_RECALL_BUDGET_SHARE = 0.5`
  (`:41`) reserve half the budget for `profile/preference/behavior/correction` in a first
  pass, episodics take the remainder, and unused durable budget is returned. The measured
  failure is recorded verbatim at `memoryRecallPolicy.mjs:26-40` (44 project-scope run
  summaries against 5 user-scope durable records; "the memory ablation's two arms
  consequently delivered byte-identical context"). The fetch layer was fixed too —
  `researchMemory.relevant()` issues a **separate query for durable kinds**
  (`researchMemory.mjs:936-946`). Run summaries now expire (90 days,
  `config.mjs:1364-1367`) and key by **question digest, not run id**
  (`memoryIntelligence.mjs:849-877`).
- **Memory not crossing the delegation boundary: fixed (2026-09-16).** The control plane
  writes `.evimed-brief/sessions/<sessionId>/memory.md` at mode 0444, **even when empty**
  so a child cannot inherit a previous dispatch's memories
  (`runtimeManager.mjs:3882-3886, 3957-3979`); the socket parks it on the session entry
  (`run-policy.mjs:1165-1171`) and `evimed_delegate` renders it into the child prompt
  (`run-policy.mjs:640` → `packages/socket/src/runPolicy.mjs:637-645`). Children also got
  the pull channel: `evimed_capsule_recall` is now in `DELEGATION_BASE_TOOLS`
  (`packages/domain/src/capabilityManifest.mjs:39-55`).

### 10.3 Provenance satisfies principle 18

`MEMORY_ORIGINS = [explicit, inferred, system, manual]`
(`apps/server/src/researchMemoryPersistence.mjs:29`, CHECK at `:67`) maps one-to-one onto
principle 18's four categories; `inferred` is forced to `status: "pending"`
(`memoryIntelligence.mjs:47-52, 336`) so an inference cannot auto-promote. Promotion needs
`MEMORY_PROMOTION_MIN_OCCURRENCES` observations across distinct runs
(`memoryIntelligence.mjs:440-461, 728-746`). Per-row `evidence jsonb` carries
`{sourceType, sourceRef, quote, observedAt, weight, fingerprint}`
(`researchMemory.mjs:156-170`), and the extractor **rejects any candidate whose
`evidenceQuote` is not a verbatim substring of the cited source**
(`memoryIntelligence.mjs:313`). The run ledger records `recalledMemories` as id/kind/scope
only, never values (`agentRuns.mjs:586-596`).

**This is the best-built subsystem in the codebase**, and it is notable that it is the one
place where quote-verbatim checking is done *by code at write time* — exactly what §1
argues the evidence matrix needs and does not have.

### 10.4 The task-brief-as-preference defect, and its three guards

Documented at `memoryIntelligence.mjs:199-205` (ten records on one account, each a whole
task brief stored as a durable `explicit` preference at importance 0.75). Guards:
sender/framing (`memorySourceRejection`, `:190-211`, refusing `role:"user"` messages whose
`source` is not `"user"` and anything matching `PLATFORM_FRAMING`, `:142`);
length (`DETERMINISTIC_SOURCE_MAX_CHARS = 1200`, `:363, 369`); and origin downgrade
(deterministic path now emits `inferred`, `:394`). Legacy rows are flagged in the UI as
「疑似任务题面，非你的陈述」 (`apps/web/src/app/routes/MemoryPage.tsx:572`).

### 10.5 Production is running `builtin`, not OpenViking

- Code default: `memoryIndexProvider` = **`"builtin"`** (`config.mjs:1341-1343`); unknown
  names read as builtin (`memorySubstrate.mjs:43-46`).
- Deploy default says the opposite: `OPEN_SCIENCE_MEMORY_INDEX_PROVIDER=openviking`
  (`deploy/web/.env.example:338`, `deploy/web/docker-compose.yml:293`).
- **What production actually reports**: every memory-ablation report keeps `/api/ready`
  verbatim, and v9/v10/v11 all record
  `"provider": "builtin"`, `"rerank": {"code": "memory_rerank_not_reached",
  "configured": false}` against `https://82.156.128.153`
  (`evals/method-quality/reports/memory-ablation-v9.json:323-338`, `v10.json:327`,
  `v11.json:327`), generated 2026-09-17.

The cost of that gap is measured offline (`evals/memory-recall/README.md`, 2026-09-14,
300 records / 12 queries / top-5):

| | recall@5 | MRR | queries returning nothing relevant | added median latency |
|---|---|---|---|---|
| builtin term matcher | 0.667 | 0.736 | 2 of 12 | — |
| qwen3.7 embedding | 0.933 | 1.000 | 0 | 274 ms |
| + control-plane rerank | **1.000** | 0.958 | 0 | 467 ms |

Capsule recall is worse still: lexical **0.000** → 0.900 with embeddings.

The reranker is fail-open by construction (`memoryRerank.mjs:154-164`, identity
permutation, logged once per outage code, returns an **order never a filter**, `:88-97`),
with a 3 000 ms timeout (`config.mjs:1135-1146`).

### 10.6 Ablation verdicts v9 / v10 / v11

All three: capability pinned to `clinical-evidence-synthesis`, arms `memory-off` (baseline)
vs `memory-on` (candidate), pre-registered `primaryDimension: taskUtility`, margin 0.02,
95% CI, 2000 bootstrap samples, judge `deepseek-v4-pro`, `projectPerCell: true`. The arms
are produced by flipping **four pinned durable records** between `active` and `pending`
(two preferences, one profile, one behavior).

| | cells | verdict | taskUtility off → on | 95% CI | notable |
|---|---|---|---|---|---|
| **v9** (pkg 2.11.0, gate blocking) | 12, repeats 3 | **worse** | 0.450 → 0.250 (−0.200) | [−0.367, −0.033] | `evidenceCompleteness` flattened to 0.0 in **both** arms |
| **v10** (pkg 2.12.0, gate non-blocking) | 12, repeats 3 | **inconclusive** | 0.800 → 0.767 (−0.033) | [−0.267, +0.200] | efficiency **better** +0.026 [0.016, 0.036]; evidenceCompleteness +0.167 but CI straddles 0 |
| **v11** (pkg 2.13.0, two-file package) | 4, repeats 1 | **inconclusive** | 0.650 → 0.900 (+0.250) | [0.0, 0.500] | evidenceCompleteness **better** +0.300; efficiency **better** +0.085; blocked by safety 1.0 → 0.9 on **2 pairs** |

Latency: v10 memory-on was 1 170 s vs 1 309 s off; v11 755 s vs 1 211 s. **Cost is
"unavailable" in every report** — "no per-run cost was joined", which is the
`model_requests.run_id` NULL gap (§9).

**Read across the three**: v9's `worse` did not reproduce once the gate stopped deciding
delivery (`PROGRESS.md:1`, 2026-09-18 02:10), and v10/v11 are directionally favourable on
efficiency and evidence completeness. But the repo's own assessment is that the evidence is
weak (`PROGRESS.md:5`): 2 brief families, 6 pairs (2 in v11), `familySource: "brief-id"`
meaning families were never declared, and **the manipulation was four generic preference
memories, not task knowledge**.

### 10.7 Default-on recommendation for deep runs

**Recall is already on by default and there is no run-level switch.** Note a
documentation/behaviour gap: `memoryEnabled` / `OPEN_SCIENCE_MEMORY_ENABLED` (default true,
`config.mjs:1328`) is described as "the subsystem's own switch" but its **only** consumer
is `memoryRoutes.mjs:58`, which makes `/api/memory*` answer 503. It does **not** gate
dispatch-time recall. The only off-paths are the researcher's own
`learningPaused`/`recallPaused`/`pausedProjects` (`researchMemory.mjs:414-419`).

That is a principle-11 problem: **there is no deployment-level control arm.** The ablation
had to manipulate four database rows instead of flipping a switch, which is why its
manipulation is "four generic preferences, not task knowledge" and why its effect sizes are
weak. The recommendation is therefore not about the default but about the instrument:

1. Add a real dispatch-time recall switch (`OPEN_SCIENCE_MEMORY_RECALL_ENABLED`) so
   memory-off is a genuine native control (principle 11).
2. Keep recall on by default — nothing measured argues for turning it off, and v10/v11
   show an efficiency gain.
3. **Switch production to OpenViking**, which is what the deploy files already intend and
   what the offline eval says buys recall@5 0.667 → 1.000. This is the single cheapest
   quality win in the memory stack and needs only the DashScope key wiring.
4. Fix `.evimed-capsule/profile.md`: `workspaceLayout.capsuleProfileFile`
   (`packages/domain/src/workspaceLayout.mjs:83`) is **read** at `run-policy.mjs:1163` and
   injected as `<evimed-capsule>`, but a repo-wide grep finds **no writer**. The resident
   profile slot is declared and consumed and nothing produces it.

---

## Sequence diagram — a deep run as it runs today

Timings are measured where marked **[M]** (from `00-live-findings.md` F4/F5/F6) and
estimated where marked **[E]**. Estimates derive from measured aggregates
(335 requests / 28 min ≈ 5 s per model round trip; 190 tool calls / 17 min ≈ 5.4 s per step).

```mermaid
sequenceDiagram
    autonumber
    actor U as Researcher
    participant W as apps/web
    participant S as apps/server
    participant C as specialistClassifier
    participant G as modelGateway
    participant K as DSH kernel (container)
    participant P as Parent session
    participant Ch as Child session
    participant M as MCP evimed-research
    participant D as @evimed/domain gate

    U->>W: types a clinical question
    W->>S: POST /api/agent-runs
    Note over W,S: [M] navigation → usable composer 10.3 s<br/>frame attached at 1.8–3.1 s (F6)
    S->>S: routeNamedSpecialist (regex, id substring)
    S->>C: classify(question)
    C->>+G: api.deepseek.com DIRECT (unmetered, no retry)
    G-->>-C: verdict + confidence
    Note over C: [E] a full reasoning turn, 5–15 s<br/>ceiling 120 s; no p50 recorded
    S->>S: routeOpenDomainSpecialist (net, narrowed by afterCleanNone)
    S->>S: memorySubstrate.recall → 8 items / 20 K chars into system prompt
    S->>K: session/prompt over /api/remote.mux
    K->>P: first turn
    Note over P,G: [E] ~55 K-token first request<br/>[M] 99% of later input tokens are cache hits

    P->>P: evimed_plan{write} — 3 deliverables, dependsOn NOT checked vs prose
    Note over S,W: runs page now shows 交付进度 0/3 · 待开始 ×3<br/>[M] and will keep showing that for the whole run (§6.1)

    P->>Ch: evimed_delegate(#1) — BLOCKS until child settles (run-policy.mjs:677)
    activate Ch
    Ch->>M: literature_search / guideline_search / trial_search
    M-->>Ch: hits (no artifact yet)
    Ch->>M: open_access_full_text / official_page_fetch
    M-->>Ch: artifactPath under .evimed-sources/
    loop [M] 146 of 190 tool calls
        Ch->>Ch: bash python — extract_quotes.py / build_matrix.py / verify_quotes.py
        Ch->>Ch: write / edit — report prose, claim markers, [n] renumbering
    end
    Note over Ch,G: [M] context climbs to 320 K → compaction at exactly 0.8×400 K<br/>drops to ~135 K, climbs back to ~300 K
    Ch->>D: evimed_submit_deliverable (#1)
    D-->>Ch: {ok:false, issues:[… up to 83 …]}
    Note over Ch,D: [M] 63% of run time is this loop (v9)<br/>up to 3 content + 3 structural attempts
    Ch->>D: evimed_submit_deliverable (#2..#5)
    D-->>Ch: ok / findings attached
    deactivate Ch
    Note over S: [M] child 1 = 24 m 52 s

    rect rgb(255, 238, 238)
        Note over S,W: MEANWHILE, for ~15 min:<br/>recordProgress sees no root history (parent blocked)<br/>and no kernel-attributed child activity (§6.2)<br/>→ 「已有约 15 分钟没有可观测的进展（…工作区也没有变化）」<br/>the third clause is never checked
    end

    P->>Ch: evimed_delegate(#2) — only now
    activate Ch
    Note over Ch: [M] starts after child 1 finished — strictly sequential
    deactivate Ch
    P->>P: evimed_complete_run
    S->>D: server-side validateClinicalEvidencePackage
    D-->>S: findings (SAFETY — first, then MUST FIX —)
    S->>W: delivered, verification:"unverified", per-claim ✓/⚠
    W->>U: report + evidence matrix
    Note over U,W: [M] whole run 28 min, ¥3.31 off-peak (¥6.61 peak)<br/>44% of the bill is cache-hit input volume
```

**The three red-flag intervals**, in wall-clock order:
1. 10.3 s to a usable composer with one line of grey text (F6).
2. ~25 min of a blank 「深度求索中…」 with a false stall notice and a frozen 待开始 ×3.
3. ~16 min (63% of the run) inside the submit/repair loop.

---

## Progress events: what we have vs what we need

"Reaches the user" means it is rendered somewhere a researcher looks during a run.
All "need" rows are **derived from tool calls already on the wire**, not from an enforced
phase machine (principle 12).

| Event | Producer today | On the wire? | Reaches the user? | Gap |
|---|---|---|---|---|
| run started / dispatched | `agentRuns.mjs:3334` ledger `started` | yes | yes (runs list) | — |
| **route chosen + why** | `effectiveAgentId` / `effectiveRouteReason` (`server.mjs:2755-2758`) | ledger only | `effectiveAgentId` after the fact; `effectiveRouteReason` **has no render site** | **render it at dispatch, with an override** |
| **estimated duration** | `capability.yaml:estimatedMinutes` | not on the wire per run | catalogue page only (`CapabilitiesPage.tsx:195`) | **show it at dispatch** |
| plan written | `evimed_plan` tool call | `run/event` | via kernel UI only | surface deliverable list + `dependsOn` graph |
| deliverable queued / started / rejected / accepted | `deliverable/update` (`agentRuns.mjs:4504-4515`) | **yes, with issues** | **no — RunsPage polls `planItems` instead** | subscribe the page to the stream it already has |
| deliverable status for an **adopted** run | `scopeNativeProjection` (`agentRuns.mjs:895-900`) | yes | **always `planned`** (§6.1) | fix the scoping function |
| child tool calls | `run/event` via the pump | yes when the child is attributed | kernel UI `ui-subagent` chip (F3) | the chip works; the runs page shows nothing |
| child turn ended | `subagent/update` (`dshEventPump.mjs:822-828`) | yes | kernel UI only | — |
| **sources preserved (count, titles)** | `evidence/update` (`agentRuns.mjs:4468`) — counts by status only | yes | not rendered per source | **name what was preserved; it is the run's own record** |
| budget (steps/tokens/children) | `budget/update` (`agentRuns.mjs:4469`) | yes | not rendered | low value until §9.4 is fixed |
| compaction | `dshEventPump.mjs:813-819` | yes | not rendered | one line: 「已压缩上下文」 |
| submission N + findings | `gateRuns` in the projection; `deliverable/update.issues` | yes | not rendered | **render attempt N and the required findings** |
| delivered + per-claim ✓/⚠ | `claimVerification` in the domain | — | yes, report popover | works |
| stall notice | `agentRuns.mjs:4719` | ledger `notice` | yes | **false for delegated work, and asserts a workspace check that does not exist** |
| 检索 | `literature_search` / `guideline_search` / `clinical_trial_search` / `biomedical_source_search` calls | yes | **no** | derive a label + query strings |
| 筛选 | `evimed_screen_batch`, `evidence_deduplicate` | yes | **no** | derive n screened |
| 全文获取 | `open_access_full_text`, `official_page_fetch` results carrying `artifactPath` | yes | **no** | derive n preserved / n attempted |
| **证据提取** | *no tool exists* — happens inside `bash python` | **no** | no | **`evimed_claim_upsert` (§1.4); this is the single biggest observability gain** |
| 撰写 | `write`/`edit` under `deliverables/<id>/` | yes | no | derive "撰写中" |
| **逐条核验** | *no tool exists*; `evimed_review_run` is the nearest | partial | no | `evimed_package_check` (§1.4) |
| 交付 | `evimed_submit_deliverable`, `evimed_complete_run` | yes | partially | — |
| cancel / steer affordance | `/steer` exists (`server.mjs:2839`); **no cancel route at all** | — | **neither has a UI** | §5.3, §9.2 |

**Summary**: of the seven medically meaningful phases, **five are already derivable from
events on the wire today and none of them is rendered**; the remaining two need the claim
tool from §1.4. The largest single fix is not new instrumentation — it is subscribing the
runs page to `deliverable/update` and fixing `scopeNativeProjection`.

---

## Findings

Size: S ≤ 1 day, M ≤ 1 week, L > 1 week. "How to measure" is the control experiment
(principles 11 and 20): same inputs, same model config, sampled more than once, with
native DSH + DeepSeek or feature-off as the control.

| # | Area | Finding | Evidence | User-visible consequence | Recommendation | Size | How to measure |
|---|---|---|---|---|---|---|---|
| 1 | Tools | No tool touches a claim, a quote, a marker or the matrix; the model hand-writes Python for all of it | `packages/domain/src/toolNames.mjs:40-110`; F5 (146/190 calls bash/write/read/edit) | 25-min children, opaque progress, 5 submissions | Add `evimed_locate_quote` (MCP), `evimed_claim_upsert`, `evimed_package_check`, `evimed_render_report` (socket) over the existing domain rules | L | A/B on the same 6 briefs: steps, wall clock, submissions, judge scores. Control = today's build |
| 2 | Observability | `GET /api/runs/:id/events` has **no consumer in `apps/web/src`** | `server.mjs:3322`; grep of `apps/web/src` finds no EventSource / `/api/runs/` fetch | The researcher sees only the kernel iframe's 「深度求索中…」 | Build a run panel on the existing stream | M | Time-to-first-meaningful-signal; researcher can answer "what is it doing now?" |
| 3 | Observability | For adopted runs, `scopeNativeProjection` recomputes item status from the **root** transcript, where a child's submissions can never appear | `agentRuns.mjs:883-907`, esp. `:895-900`, `:861`, `:903-904` | 「交付进度 0/3 · 待开始 ×3」 for the whole run (F4) | While a run is live, take item status from the projection; keep the native scoping for terminal attribution | S | Replay F4's projection; assert statuses track `rejected/attempts 2` |
| 4 | Observability | Same function empties `subagents`, so child liveness is never read → false 15-min stall notice, whose text also asserts a workspace check that does not exist | `agentRuns.mjs:903-904`, `:4573`, `:4661`, `:4719`; `runtimeManager.mjs:5239-5248` | A working run is announced as stuck | Fix #3; drop the unverified third clause from the notice | S | Run F4's shape; assert no stall notice while a child is writing |
| 5 | Concurrency | `evimed_delegate` awaits the child inside its own tool call, and does not set `concurrencySafe` | `packages/socket/plugins/run-policy.mjs:677`, `:592-604`; `packages/harness-port/index.mjs:141,153` | A 2-deliverable run takes 2× as long (F4: 26m53s) | Non-blocking delegate + `evimed_await` + `concurrencySafe: true`; add a per-entry write lock first | M | Wall clock for a 2–3 deliverable brief, parallel vs serial, 3 repeats |
| 6 | Concurrency | `maxParallelChildren` means "concurrency wave" in screening and "lifetime total" in delegation | `screening.mjs:93` vs `packages/socket/src/runPolicy.mjs:156-158`, `run-policy.mjs:670` | Operator raises a knob and nothing changes | Split into `maxChildrenTotal` and `maxConcurrentChildren` | S | Config test |
| 7 | Cost | 44% of the bill is cache-hit input volume; average carried context is ~220 K tokens | `metering.mjs:172-182` × F4 counts = ¥3.304 vs ¥3.31 measured | ¥3.31/run off-peak, ¥6.61 peak | Cut steps (#1); lower `EVIMED_COMPACTION_THRESHOLD_RATIO` 0.8 → 0.5 | S (the ratio) | Same brief at 0.8 / 0.6 / 0.5: total tokens, cost, judge scores |
| 8 | Cost | The reservation estimate is ~250× real (bytes counted as tokens, all priced as cache-miss) | `modelGateway.mjs:341-349` | Any real spend cap refuses runs at 1/250 of true spend | Estimate from a token count and split cached/uncached | S | Compare reservation to settled cost over 20 runs |
| 9 | Cost | `model_requests.run_id` is NULL for every interactive run, by construction | `runtimeManager.mjs:1252-1260`, `:2892-2912`; `usageLedger.mjs:174` | `/api/runs/:id/usage` returns zeros; `runLimit` has never fired; evals cannot price their arms | Accept the signed budget marker as a source, or rotate the token per run | M | Assert non-null `run_id` on a dispatched run |
| 10 | Model | One model, `reasoning_effort: high`, thinking on, for every request; the `model` option is silently dropped | `modelGateway.mjs:328-337`; `runtimeManager.mjs:3870`; `run-policy.mjs:599-603` | Every mechanical `read` pays for a reasoning turn | Make the lever exist (delegate `model`/`effort`), then measure per-role tiering | M | Planner max / worker low vs all-high: cost, wall clock, judge scores |
| 11 | Sources | Unpaywall unconfigured → the non-PMC full-text path throws 503 before lookup; full text is PMC-only | `publicSourceGateway.mjs:709-712`; `connectorCredentials.mjs:28-95` | A DOI without a PMC copy cannot carry a claim | Add the credential | **XS** | Count preserved full texts per run, before/after |
| 12 | Sources | PubMed abstracts fetched for the top 5 hits only | `public_sources.py:35`, `:2067-2070` | Screening beyond rank 5 is title-only, which the SKILL forbids | Raise the limit / fetch on demand for screened-in records | S | n sources inspected beyond title, per run |
| 13 | Sources | `official_page_fetch` reaches 7 hosts; no NICE, NMPA, CDE or WHO | `official_pages.py:18-26` | Guideline and label claims fall back to search hits | Add the registries that are legally reachable | M | Guideline citations resolvable per run |
| 14 | Medical assets | `药品说明书数据库_医药数据查询/` and `中医药数据/` are referenced nowhere; only 22 CSVs of `重点整理数据表/` are built in, and by filename convention only | grep of `OpenScience/`; `build_pharmacy_reference.py:25-48` | A Chinese evidence product with no NMPA label source | Build a label index the way the pharmacy reference was built | M | Label-backed claims per drug question |
| 15 | Medical rules | `clinical-safety-rules.json` holds 4 rules and 2 routing entities, all one scenario | `packages/domain/src/clinical-safety-rules.json` | F4's aspirin question matched no rule | Pharmacist-authored expansion; no code change | S/rule | Safety dimension in the eval harness, per added scenario |
| 16 | Medical method | Nothing executes GRADE or any RoB instrument; both deterministic checkers are advisory | `appraisalContract.mjs:24-35`, `:593-641`; `clinicalEvidence.mjs:731-803` | "GRADE 中等" is the model's prose, not a computed rating | Keep advisory; add per-domain structured input so the ladder is recomputed from parts | M | Agreement between stated and recomputed certainty |
| 17 | Normalisation | No MeSH expansion, no ATC, no PICO extraction, no study-design classification; UMLS unconfigured so `term_normalize` falls back to **7** vocabulary entries | `server.py:820-828`; `appraisalContract.mjs:109-122`; §7.4 | Recall depends on the model's own query phrasing | Add MeSH expansion first (E-utilities already keyless) | M | recall@k on a fixed question set |
| 18 | Routing | The route is never shown at decision time and is not overridable; `putWebResearchSession` has no UI call site | `server.mjs:2755-2758`; `apiClient.ts:1395-1406`; `CapabilitiesPage.tsx:118-121` | A question becomes a 30–120 min run with no warning and no way back | Render `effectiveRouteReason` + estimated minutes at dispatch with a one-click switch | S | Wrong-line rate and correction rate |
| 19 | Control | **There is no cancel.** No `/api/agent-runs/:id/cancel` route, no UI control; `/steer` exists with no web call site | `server.mjs:2620-2868`; `RunsPage.tsx` | A wrong 30-min run must be waited out | Add cancel; wire `/steer` | S | Abandonment / correction rate |
| 20 | Reliability | The brief lives only in process memory; a restart makes the gate skip question-scoped safety rules | `agentRuns.mjs:3016`, `:181-196`, `:4005-4008` | "Losing the exam paper made the grade go up" | Durable 0600 brief sidecar keyed by run id | S | Restart mid-run; assert `verification !== "unchecked"` |
| 21 | Reliability | A dispatch refused 429 still leaves a run row in `running`/`unknown`, and `agent_run_active` then refuses the retry | `agentRuns.mjs:3388`, `:3418-3420`, `:3279-3281` | "Too many runtimes", then "a run is already active" | Release the reservation on a capacity refusal | S | Force the 429; assert no orphan row |
| 22 | Reliability | Gate-run records key on `charged`, which does not advance for structural submissions — the second overwrites the first | `run-policy.mjs:817-818`, `:1381-1384` | The unreadable-submission history the allowance exists to expose is lost | Key on a monotonic sequence | S | Two unreadable submissions; assert two rows |
| 23 | UX | Inbox bodies carry raw English validator prose; the grouping table exists in the web lib and the notifier never calls it | `notificationService.mjs:136`; `runPresentation.ts:202-226` | 「claims[52].claim numeric fact 6 is not present…」 to a Chinese-reading researcher (F7) | Group/localise in `runFinishedNotice`; longer term emit `{code, params}` from the domain | S then M | Read a finished run's inbox item; no English validator sentence |
| 24 | Plan integrity | `evimed_plan` does not validate capability ids; `dependsOn` is enforced but never checked against the plan's own prose | `packages/domain/src/plan.mjs:93-96` vs `:113-126`; `run-policy.mjs:624-629` | A typo'd id delivers nothing, discovered mid-run; F4's summary declared no dependencies while its prose said it had two | Validate the id in `indexPlan`; ask the model to restate the graph | S | Plan with a bad id; assert refusal at plan time |
| 25 | Prompt | `ROOT_VISIBLE_MCP_BASE_NAMES` (5 tools) is exported and has zero consumers; the parent carries all 34 MCP schemas (~10 K tokens) every request | `toolNames.mjs:123-130`; `packages/domain/index.mjs:41`; measured 38 224 chars | ~10 K tokens × 335 requests of dead weight | Apply the filter that is already written | **XS** | First-request token count, before/after |
| 26 | Memory | Production runs the `builtin` term matcher; the deploy files say `openviking` and the reranker is unconfigured | `config.mjs:1341-1343` vs `deploy/web/.env.example:338`; every ablation report's `/api/ready` | recall@5 0.667 instead of 1.000; 2 of 12 queries return nothing relevant | Switch production to OpenViking + DashScope rerank | S | The existing `evals/memory-recall` harness |
| 27 | Memory | There is no deployment-level recall switch — `memoryEnabled` only gates `/api/memory*` | `config.mjs:1328`; `memoryRoutes.mjs:58` | No native control arm; the ablation had to flip four DB rows | Add `OPEN_SCIENCE_MEMORY_RECALL_ENABLED` | S | Re-run the ablation with a real off arm |
| 28 | Memory | `.evimed-capsule/profile.md` is read and injected; nothing writes it | `workspaceLayout.mjs:83`; `run-policy.mjs:1163` | The resident-profile slot is always empty | Write it, or delete the read | S | Assert non-empty for a user with a capsule |
| 29 | Skill | `clinical-evidence-synthesis/SKILL.md` forbids grep on the report and ships a Python heredoc as a required step | `SKILL.md:1656`, `:1744-1770`, `:1797-1802` | Teaches the run to script; 55 inline-Python calls per run (F5) | Replace with `evimed_package_check` output once #1 lands | S (after #1) | Inline-Python call count per run |
| 30 | Architecture | The adopted path (kernel UI) is the normal interactive path, and it has the weaker monitor, the wrong projection scoping and `verification: "unchecked"` by design | `agentRuns.mjs:4800-4814`, `:4862-4869`, `:2665` | The everyday path is the least observed and least verified one | Decide deliberately: either make adoption first-class or make dispatch the interactive path | M | Share of runs adopted vs dispatched |

---

## The 12 highest-leverage changes, in priority order

Each is checked against the 20 principles. Where a tempting adjacent fix would violate one,
that is said.

---

### 1. Give the run a claim-level tool surface — `evimed_package_check` first, then `evimed_claim_upsert`, `evimed_locate_quote`, `evimed_render_report`

**Why first**: it is simultaneously the answer to "why is it slow" (146 of 190 steps),
"why is it opaque" (证据提取 and 逐条核验 happen inside `bash python`), "why does it cost
¥3.31" (220 K average context), and "why 5 submissions" (the run learns the contract by
failing it). Nothing else in this list touches four problems at once.

**Start with `evimed_package_check`** — a read-only second entry to the `gateDeliverable`
call at `run-policy.mjs:784-792` that does not touch `entry.attempts`. It is a pure
refactor, it is what `SKILL.md:1656` already tells the model exists, and it can ship in a
day with a measurable control.

**Principles**: 1 ✅ (deterministic properties move from model to code — this is the
principle's central example). 3 ✅ (compiler-style verdict, repaired in place). 8 ✅
(explicitly deletable when models can hold a 200-claim matrix reliably). 9 ⚠ — a new tool
is not a capability package, so it needs the tool-design discipline of the plugin-first
section: one responsibility each, parameters stating required/optional/default/unit/range,
results stating fact/source/caliber/missing/scope.

**Would violate a principle**: making `evimed_claim_upsert` *mandatory* before
`evimed_submit_deliverable`. That is a staged workflow dressed as a data dependency
(principle 12) and a new blocking point (principle 4). The tools must be strictly
cheaper-than-the-alternative, never required.

**Measure**: same 6 briefs, tools on vs off, 3 repeats. Report tool-call count, inline-Python
count, wall clock, submissions per deliverable, total tokens, cost, and the four judge
dimensions. Control = today's build.

---

### 2. Subscribe the frontend to `GET /api/runs/:id/events`

**Why**: the stream is built, attributed, debounced, tested and **read by nobody**
(`server.mjs:3322`; no consumer in `apps/web/src`). Five of the seven medically meaningful
phases are already on it. This is the largest gap between what the platform knows and what
the researcher sees, and it requires no new events.

**Scope**: a run panel showing 检索/筛选/全文获取/撰写/交付 derived from tool-call events,
the deliverable list with live status and required findings, sources preserved by name,
and a compaction line.

**Principles**: 12 ✅ — phases are *labels on observed tool calls*, never enforced; a
zero-tool answer shows no phases. 13 ✅ — nothing here gates a reply. 16 ✅ — nothing is
added to the prompt.

**Would violate a principle**: making the model emit phase markers so the UI has something
to render. That is a forced phase switch per turn (principle 12) and a prompt mandate
(principle 16). Derive, never instruct.

**Measure**: can a researcher answer "what is it doing now?" at a random minute of a run;
time-to-first-meaningful-signal; abandonment rate.

---

### 3. Fix `scopeNativeProjection` for live adopted runs

**Why**: one function (`agentRuns.mjs:883-907`) causes both F4 defects — 「待开始 ×3」 for a
run that had a rejected deliverable at attempt 2 (§6.1) and the false 15-minute stall notice
(§6.2), because it empties `subagents` and so no child liveness is ever read. The adopted
path is the *normal* interactive path (§9.6), so this is everyday behaviour, not an edge.

**Scope**: while `status === "running"`, take item status and `subagents` from the
projection; keep the native scoping for terminal attribution, which is what it was written
for. Separately, delete the notice's third clause (「工作区也没有变化」) — nothing checks it.

**Principles**: 14 ✅ — an engineering boundary stays in code. 19 ✅ — a partial result
(the projection) is kept rather than discarded.

**Would violate a principle**: letting the projection reset the stall counter. The comment
at `agentRuns.mjs:4658-4660` is right — it is a model-writable document. The fix is to
**read child liveness**, not to trust the projection as a heartbeat.

**Measure**: replay F4's projection through `withPlanProgress` and `recordProgress`; assert
statuses track and no stall notice fires while a child is writing.

---

### 4. Cap `readSkillBodies`, and cut the parent's dead tool schemas

Two independent changes, both pure savings:

- **Cap the pre-injected skill bodies** (`run-policy.mjs:1243-1248`) the way the answer
  persona already is (`guidance.mjs:36`), with a diagnostic when it bites. A
  `clinical-evidence-synthesis` child is handed **158 088 bytes ≈ 52.7 K tokens** before its
  first tool call, re-sent on every one of ~190 steps. This is the floor under the 220 K
  average context.
- **Apply `ROOT_VISIBLE_MCP_BASE_NAMES`** (`toolNames.mjs:123-129`) — an existing, exported,
  zero-consumer constant. −33 762 chars ≈ −8 440 tokens off every parent request. Plus
  `tool-workflow` and `tool-subagent*` (−8 734 chars), which nothing references.

**Principles**: 16 ✅ — "prompts stay short and stable; tool usage and domain detail live in
tool descriptions, SKILL.md and knowledge resources". 8 ✅ — deleting scaffolding.

**Would violate a principle**: cutting the SKILL.md *content* to fit. The medical prose is
the moat (principle 8) and the priors (principle 7). Cap by splitting the body so the child
loads what it needs through the `skill` tool — the kernel's own extension point, preferred
over a prompt mandate.

**Measure**: first-request token count before/after; then judge scores on the same 6 briefs
to confirm the cap did not remove instructions the run needed.

---

### 5. Make delegation non-blocking

**Why**: `await awaitOwnedSubagent` inside the tool (`run-policy.mjs:677`) halves throughput
on any multi-deliverable run (F4: 26m53s for work that is ~13 min in parallel), and it is
the reason the parent's transcript is frozen for 25 minutes, which is what starves §3's
stall detector.

**Scope**: return a child handle; add `evimed_await`; set `concurrencySafe: true`
(`harness-port/index.mjs:141,153`); split `maxParallelChildren` into `maxChildrenTotal` and
`maxConcurrentChildren`; **add a per-entry write lock around the submit/persist path first**
(`run-policy.mjs:778-818` read-modify-writes `entry.attempts` across two awaits).

**Principles**: 12 ✅ — tool order follows a real data dependency (`dependsOn`), which is
exactly the exception the principle names. 15 ✅ — the concurrency cap gets a reason, a
config key and a counter.

**Would violate a principle**: instructing the model in the prompt to "always delegate in
parallel". That is a fixed tool mandate (principle 16). Make it possible and let
`dependsOn` decide.

**Measure**: wall clock for a 2–3 deliverable brief, parallel vs serial, 3 repeats; watch
for workspace write collisions and gate interleaving.

---

### 6. Show the route and let the researcher change or stop it

Three small wirings of endpoints that already exist:

- render `effectiveRouteReason` + the capability's `estimatedMinutes` **at dispatch**
  (today `effectiveRouteReason` has no render site anywhere and the duration is only on the
  catalogue page);
- a one-click "改用 X" calling `PUT /api/research-sessions/:id`, whose client function
  `putWebResearchSession` exists with **no call site** (`apiClient.ts:1395-1406`);
- **a cancel button** — and the route behind it, because `/api/agent-runs/:id/cancel` does
  not exist at all (§9.2). Wire `/steer` (`server.mjs:2839`) at the same time.

**Why**: a question silently becomes a 30–120 minute run with no warning, no override and
no stop. `specialistRouting.mjs:97-115` records the opposite failure in production too — a
request for a report that became a chat message, with "no report and no gate."

**Principles**: 2 ✅ — this shapes behaviour at the boundary, not with more input-side
keyword walls. 20(c) ✅ — it stops nothing native DSH could do; it restores control.

**Would violate a principle**: widening the regex net to catch 写出所有的分析结果和报告.
Principle 5 is explicit — "Tempted to widen a prose pattern? Write an eval case instead."
The correct fix is the visible, reversible choice.

**Measure**: wrong-line rate, correction rate, abandonment rate.

---

### 7. Add the Unpaywall credential

**Why**: `publicSourceGateway.mjs:709-712` throws `503` **before any lookup**, so the entire
non-PMC open-access full-text path is dead. Today a paper with a DOI and no Europe PMC copy
returns `full_text_not_available` and therefore **cannot carry a claim**
(`SKILL.md:1102`). This is a hard ceiling on evidence quality that costs one email address
in a credentials file.

Ship alongside: raise `PUBMED_ABSTRACT_FETCH_LIMIT` from **5** (`public_sources.py:35`), or
fetch on demand for screened-in records — screening beyond rank 5 is currently title-only,
which `SKILL.md:1659` forbids.

**Principles**: 10 (external services) ✅ — a pin and a provider, no consumer change.

**Measure**: preserved full texts per run, claims backed by `accessLevel: full_text`,
before/after.

---

### 8. Attribute per-run usage

**Why**: `model_requests.run_id` is NULL for every interactive run **by construction**
(§9.4), so `/api/runs/:id/usage` returns zeros, the `runLimit` cap has never fired, and
**every ablation report says cost is "unavailable"** — the evals cannot price their own
arms, which is why no efficiency claim in v9–v11 has a cost number behind it.

**Scope**: the smallest change relaxes `modelGateway.mjs:119-121` so the already-signed
budget marker can be a *source* when the token has no `runId`, not only a cross-check.
Alternative: rotate `model-gateway.token` per run. Fix the reservation estimator at the same
time (`modelGateway.mjs:341-349` counts bytes as tokens and prices everything as
cache-miss — ~250× over).

**Principles**: 11 and 20 ✅ — this is the instrument that makes every other measurement on
this list possible. 15 ✅ — a limit needs an observable counter.

**Measure**: assert non-null `run_id` on a dispatched run; compare reservation to settled
cost over 20 runs.

---

### 9. Make memory measurable, then switch the index

Two changes that belong together:

- **Add `OPEN_SCIENCE_MEMORY_RECALL_ENABLED`.** There is no deployment-level recall switch
  today — `memoryEnabled` only gates `/api/memory*` (`memoryRoutes.mjs:58`). The ablation
  had to flip four database rows instead, which is why its manipulation is "four generic
  preferences, not task knowledge" and its effect sizes are weak (`PROGRESS.md:5`).
- **Switch production to OpenViking + DashScope rerank**, which the deploy files already
  intend (`deploy/web/.env.example:338`) while `/api/ready` reports `builtin` with no
  reranker in every ablation report. The offline eval says this buys recall@5 0.667 → 1.000
  and takes 2 of 12 "nothing relevant" queries to 0.

Also: write `.evimed-capsule/profile.md` or delete the read (`workspaceLayout.mjs:83` /
`run-policy.mjs:1163` — read, injected, never written).

**Principles**: 11 ✅ — native-control discipline requires the off arm to exist. 18 ✅ — the
provenance model is already correct and is the best-built part of the system.

**Would violate a principle**: turning recall off by default on the strength of v9's
`worse`. `PROGRESS.md:1` records that it did not reproduce once the gate stopped deciding
delivery, and v10/v11 show an efficiency gain. No evidence, no change (principle 20e).

**Measure**: re-run the ablation with a real off arm and a pinned index provider; use the
existing `evals/memory-recall` harness for the index swap.

---

### 10. Give the gate a durable brief, and stop the 429 orphan

Two small reliability fixes with disproportionate consequences:

- **The brief lives only in process memory** (`agentRuns.mjs:3016`). After a control-plane
  restart the gate runs with `brief = null`, records
  `skippedChecks: ["question-scoped-safety-rules"]` and delivers `verification:
  "unchecked"` — i.e. **the pharmacist-authored safety layer is silently off for that run**.
  The code's own summary: "Losing the exam paper made the grade go up"
  (`agentRuns.mjs:181-196`). Fix: a 0600 sidecar keyed by run id, outside the 1 MiB ledger.
- **A capacity-refused dispatch leaves an orphan run row.** `runtime_limit_exceeded` is not
  `definitivelyRejected`, so the run is marked `running`/`unknown` and monitored
  (`agentRuns.mjs:3418-3420`) while the caller gets a 429 — and `agent_run_active` (409)
  then refuses the retry. Release the reservation on a capacity refusal.

**Principles**: 14 ✅ — engineering boundaries stay in code; a failed operation must not
block the rest. 19 ✅ — failure keeps the partial result, and is traceable.

**Measure**: restart mid-run and assert `verification !== "unchecked"`; force the 429 and
assert no orphan row.

---

### 11. Localise the inbox, and give the gate structured findings

**Why**: `notificationService.mjs:136` puts raw English validator prose into a Chinese
researcher's inbox (「claims[52].claim numeric fact 6 is not present in its direct
support…」). The grouping table that fixes it **already exists and is never called** —
`apps/web/src/lib/runPresentation.ts:213-226`, whose own comment names both the defect and
the real fix: "the gate emitting a code plus parameters instead of an English sentence."

**Scope**: (a) group and localise in `runFinishedNotice` — size S; (b) make the server-side
`validateClinicalEvidencePackage` path emit `{code, params}` as the socket path already
does — size M, and it makes the inbox, the runs page, the ledger and the evals all speak the
researcher's language from one change.

**Principles**: 16 ✅ — "Replies use the user's language; internal fields, error codes and
engine internals stay out of the body unless they help the reader."

**Measure**: read a finished run's inbox item; no English validator sentence survives.

---

### 12. Grow `clinical-safety-rules.json`, and make the plan validate its own ids

The medical-credibility item and the plan-integrity item, paired because both are cheap and
neither is engineering-heavy:

- **`clinical-safety-rules.json` is four rules and two routing entities, all one
  scenario** (速效救心丸 / chest pain), plus a 142-name advisory watchlist. F4's own
  question — aspirin primary prevention in the over-70s — matched **no rule**. This file is
  the single place where pharmacist expertise converts directly into product behaviour
  without touching code, and it is the repo's own stated pattern (principle 7: "priors live
  in context, not control flow"). Each added scenario is size S and is domain work.
- **`evimed_plan` does not validate capability ids** (`packages/domain/src/plan.mjs:93-96`)
  even though it fully validates `dependsOn` including cycles (`:113-126`) and the catalogue
  is in the same `ctx` accessor the delegate tool uses two functions later. A typo'd id
  becomes *nothing delivered*, discovered mid-run after the user has been shown a 3-item
  list.

**Principles**: 7 ✅, 1 ✅ (a closed vocabulary check belongs in code), 3 ✅ (the verdict
arrives when it can still be acted on cheaply). 5 ✅ — medicine/scenario rules go in the
JSON, never into new prose regex.

**Would violate a principle**: adding more open-vocabulary Chinese prose regex to the
`.mjs`. Principle 5 forbids it; the JSON is the sanctioned form, and even there the four
existing regexes (one is ~1 200 chars of negation lookbehind) are a warning about where this
goes if it is not kept to closed entity vocabularies plus short scenario patterns.

**Measure**: the safety dimension in the eval harness, per added scenario; a plan with a bad
id refused at plan time.

---

### Ordering rationale

1–3 are the product's three visible symptoms (slow, opaque, wrong status) and share one
root cause each that nothing else fixes. 4–5 are the cost and throughput multipliers, and
both are prerequisites for measuring 1 honestly. 6 is the largest UX gap and the cheapest
per unit of researcher trust. 7 is the cheapest medical-quality win in the repo. 8 is the
instrument everything else is measured with — it could reasonably move to #1 if the team
wants every subsequent claim to carry a cost number. 9–12 are the durable-quality items.

---

## Open questions for the owner

1. **Is the kernel's own UI the intended product surface, or a stopgap?** Everything about
   the observability story turns on this. Today `apps/web` embeds the kernel iframe
   (`SessionRoute.tsx:94`) and the entire `RunEvent` stream the architecture guardrail was
   built for has no consumer. Recommendation #2 assumes the answer is "our own surface owns
   progress, the kernel owns the conversation" — please confirm before it is built.
2. **Adopted vs dispatched: which is the interactive path?** The adopted path is what a
   researcher actually hits, and by design it has no monitor unless a contract was routed,
   the wrong projection scoping, and `verification: "unchecked"`. Making adoption
   first-class and making dispatch the interactive path are different products.
3. **Per-role model tiering — worth the lever?** Nothing can be tiered today (the `model`
   option is dropped at `runtimeManager.mjs:3870` and `evimed_delegate` has no model
   parameter). Building the lever is size M. Is `deepseek-v4-pro` for the `review` verifier
   and `effort: low` for mechanical child steps worth measuring, or is one-model simplicity
   a deliberate product decision?
4. **How far should the pharmacy reference be allowed to go?** 10 929 rows are live and every
   one is stamped `user_provided_other`, so none can carry a claim. Is the intent that it
   stays a lookup aid, or should a curated subset be promoted to citable with a named
   provenance?
5. **NMPA labels and Chinese guidelines**: `药品说明书数据库_医药数据查询/` (8 xlsx) is
   unused, the NMPA local-label adapter is `ready_private_adapter` and unbuilt, and every
   Chinese registry is `blocked_license`. Which of these is a licensing decision you want to
   pursue, and which should be built from data already on disk?
6. **Who owns `clinical-safety-rules.json`?** It is the highest-leverage medical artifact in
   the repo and it has four rules. Is there a pharmacist who can author scenarios, and what
   would they need (a schema doc, a test harness, a review loop)?
7. **Should `evimed_review_run` upgrade to a stronger model?** It is the only role where a
   second opinion's quality is the entire point, it runs once, it is bounded at 40 claims,
   and its own header records that at flash quality it produces ~4 pieces of noise per real
   finding and cannot reproduce itself at temperature 0.
8. **Delivery-attempt budget after tools land.** If `evimed_package_check` ships, is
   `deliveryAttemptLimit: 3` still the right number, or should submission become nearly
   free once a run can check itself?
9. **Is `deepseek-flash`'s 400 K window the right operating point?** Compaction now fires at
   exactly 320 K and the request body is ~1.3 MB against a 2 MiB hard limit
   (`config.mjs:1077-1079`) with no retry. Lowering the threshold ratio is one env change;
   it trades a little continuity for a lot of cost and headroom.
10. **Not determined and worth a live probe**: whether the kernel emits `origin: "subagent"`
    on `session/list` and `subagent/started` on the parent's stream (the two independent
    preconditions for child liveness, §6.2); whether the kernel cascades `session/cancel` to
    children (§9.2); whether `dsh-tool-skill` renders the 57-skill / 17.3 KB catalogue into
    the system prompt and whether discovery has settled before the first assembly (§2.3
    risk 1). Each is a single live session to answer and each changes a recommendation.

---

## Confidence and limits

- Every claim above is tied to a file and line in this checkout, or to a measured number in
  `00-live-findings.md` / an eval report on disk. Where neither existed, the text says
  **not determined** rather than estimating.
- Nothing was run against production. No code was modified.
- The largest unverified area is the **kernel's own behaviour** — whether it emits the
  subagent attribution fields, cascades cancellation, groups parallel tool calls, and where
  it renders the skill catalogue. Four of this audit's conclusions would sharpen with one
  live `session/list` and one recorded first-turn frame from the current image.
- Timings marked **[E]** in the sequence diagram are derived from measured aggregates, not
  observed per-step.
