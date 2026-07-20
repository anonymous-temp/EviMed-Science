# EviMed Unified Agent Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hosted EviMed research-agent foundation on the current OpenScience codebase, preserving open-domain research while adding reusable specialty-agent packages, per-turn agent binding, DeepSeek gateway bootstrap, and a minimum EviMed Research MCP tool loop.

**Architecture:** Keep the React UI behind `packages/sdk` and the hosted server's authenticated OpenCode proxy. Define each specialty once as `agent.yaml + SKILL.md`; the server validates and exposes packages, bootstraps matching OpenCode custom agents, and the UI pins the selected agent on every turn. Keep model credentials server-side and expose medical/research capabilities through one MCP process with stable envelopes instead of a second workflow DSL.

**Tech Stack:** React 19, TypeScript, Zustand, React Router, Vitest, Node.js ESM, Node test runner, OpenCode HTTP/SSE, YAML, MCP JSON-RPC over stdio, DeepSeek OpenAI-compatible Chat Completions API.

---

## File map

- `OpenScience/packages/sdk/src/runtime.ts`: runtime-agnostic UI boundary.
- `OpenScience/packages/sdk/src/OpenCodeClient.ts`: concrete OpenCode transport, including optional per-turn agent/model pins.
- `OpenScience/apps/server/src/agentRegistry.mjs`: package discovery, validation, public catalog, and OpenCode agent materialization.
- `OpenScience/apps/server/src/agentRuns.mjs`: bounded project-scoped JSONL run ledger folded into reproducible turn summaries.
- `OpenScience/apps/server/src/modelGateway.mjs`: server-owned DeepSeek-compatible request forwarding and secret redaction.
- `OpenScience/apps/server/src/server.mjs`: authenticated agent catalog and model-gateway routes.
- `OpenScience/apps/server/src/runtimeManager.mjs`: copies skills and generated custom-agent definitions before runtime startup.
- `OpenScience/runtime/skills/evimed/*`: ADR and off-label product packages.
- `OpenScience/runtime/mcp/evimed-research/*`: one MCP process and stable tool/result contracts.
- `OpenScience/apps/desktop/src/lib/apiClient.ts`: hosted API types and catalog calls.
- `OpenScience/apps/desktop/src/lib/runtime.ts`: draft/session specialty binding and per-turn pinning.
- `OpenScience/apps/desktop/src/app/routes/AgentsPage.tsx`: specialty-agent catalog.
- `OpenScience/apps/desktop/src/components/sidebar/Sidebar.tsx`: “Research Agents” entry below Files.
- `OpenScience/apps/desktop/src/app/routes/LiveSessionPage.tsx`: shared multi-turn conversation surface with specialty identity.

### Task 0: Stabilize the Node 24 test baseline

**Files:**
- Modify: `OpenScience/apps/desktop/src/lib/apiClient.test.ts`
- Modify: `OpenScience/apps/desktop/src/app/layout/AppShell.web.test.tsx`
- Modify: `OpenScience/apps/server/test/runtimeController.test.mjs`

- [x] **Step 1: Replace JSDOM-only Blob assertions with an environment-neutral reader**

Add this helper and use it for exported/downloaded blobs:

```ts
async function blobText(blob: Blob): Promise<string> {
  return new Response(blob).text();
}
```

- [x] **Step 2: Align browser globals in AppShell tests**

Install one coherent Undici/JSDOM set in the suite before navigation:

```ts
beforeAll(() => {
  vi.stubGlobal("AbortController", globalThis.AbortController);
  vi.stubGlobal("AbortSignal", globalThis.AbortSignal);
});
```

If the suite already replaces `Request`, construct it without passing a foreign `signal`.

- [x] **Step 3: Make Unix-socket controller tests skip on a host that returns `EINVAL` for the temporary socket path**

Keep assertions unchanged when Unix sockets are supported; classify only `EINVAL` from `connect` as an environment skip and keep every other error failing.

- [x] **Step 4: Verify the clean baseline**

Run:

```bash
cd OpenScience
pnpm typecheck
pnpm test
pnpm test:server
```

Expected: TypeScript succeeds; desktop tests have zero failures; server tests have zero failures or an explicit platform skip for unsupported Unix sockets.

### Task 1: Formalize AgentRuntime and per-turn agent/model pinning

**Files:**
- Create: `OpenScience/packages/sdk/src/runtime.ts`
- Modify: `OpenScience/packages/sdk/src/index.ts`
- Modify: `OpenScience/packages/sdk/src/OpenCodeClient.ts`
- Test: `OpenScience/apps/desktop/src/test/opencode-client.node.test.ts`

- [x] **Step 1: Write the failing request-contract test**

```ts
it("pins an agent and model on a prompt turn", async () => {
  const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
  const sessionId = await client.createSession();
  await client.sendPrompt(sessionId, "analyze", "evimed-adr-analysis", "deepseek/deepseek-v4-pro");
  expect(server.lastPromptBody).toMatchObject({
    agent: "evimed-adr-analysis",
    model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
  });
});
```

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run src/test/opencode-client.node.test.ts -t "pins an agent and model"
```

Expected: FAIL because `sendPrompt` ignores the optional pins.

- [x] **Step 3: Add the runtime seam and implement it**

Use this session signature in `AgentRuntime` and `OpenCodeClient`:

```ts
sendPrompt(sessionId: string, text: string, agent?: string, model?: string | null): Promise<void>;
```

Build the OpenCode request without undefined fields:

```ts
const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
if (agent) body.agent = agent;
if (model) {
  const [providerID, ...modelParts] = model.split("/");
  body.model = { providerID, modelID: modelParts.join("/") };
}
```

- [x] **Step 4: Run focused and SDK-adjacent tests**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run src/test/opencode-client.node.test.ts src/lib/runtime.store.test.ts
pnpm typecheck
```

Expected: PASS.

### Task 2: Add validated specialty Agent Packages and catalog API

**Files:**
- Modify: `OpenScience/apps/server/package.json`
- Create: `OpenScience/apps/server/src/agentRegistry.mjs`
- Modify: `OpenScience/apps/server/src/config.mjs`
- Modify: `OpenScience/apps/server/src/server.mjs`
- Create: `OpenScience/runtime/skills/evimed/adr-analysis/agent.yaml`
- Create: `OpenScience/runtime/skills/evimed/adr-analysis/SKILL.md`
- Create: `OpenScience/runtime/skills/evimed/off-label-analysis/agent.yaml`
- Create: `OpenScience/runtime/skills/evimed/off-label-analysis/SKILL.md`
- Test: `OpenScience/apps/server/test/agentRegistry.test.mjs`
- Test: `OpenScience/apps/server/test/server.test.mjs`

- [x] **Step 1: Write failing registry validation tests**

Cover a valid package, duplicate IDs, missing `SKILL.md`, unknown tool IDs, path traversal in output paths, and a manifest whose `skill` does not match its directory.

```js
assert.deepEqual(registry.list().map((agent) => agent.id), ["adr-analysis", "off-label-analysis"]);
assert.throws(() => validateAgentPackage(bad), /unknown tool/i);
```

- [x] **Step 2: Run registry tests and confirm RED**

Run:

```bash
pnpm --filter @ai4s/server exec node --test test/agentRegistry.test.mjs
```

Expected: FAIL because the registry module does not exist.

- [x] **Step 3: Implement the manifest contract**

Use `yaml@2.4.2` and validate this public shape:

```js
{
  id: "adr-analysis",
  version: "1.0.0",
  title: "Drug Safety Analysis",
  description: "Mine adverse-event signals and synthesize evidence.",
  category: "Pharmacovigilance",
  estimatedMinutes: [20, 40],
  starterPrompts: ["Analyze osimertinib and cardiac-toxicity signals"],
  requiredInputs: ["drug"],
  optionalInputs: ["adverseEvent", "dateRange", "uploadedFiles"],
  requiredTools: ["evimed_term_normalize", "evimed_adr_signal"],
  optionalTools: ["evimed_evidence_search"],
  dataSources: ["faers", "meddra", "drug-labels"],
  outputs: [
    { path: "reports/adr-analysis.md", required: true },
    { path: "artifacts/adr-analysis.json", required: true },
  ],
  completionChecks: ["requiredOutputsExist", "citationsResolvable"],
  runtimeAgent: "evimed-adr-analysis",
  skill: "adr-analysis",
}
```

`runtimeAgent` is derived by the registry and is not authored in `agent.yaml`. Allow only IDs matching `/^[a-z0-9][a-z0-9-]{1,62}$/`, semantic versions, declared tools/data sources/completion checks, and normalized relative output paths. Reject `steps`, branches, transitions, and every unknown field so this manifest cannot become a workflow DSL.

- [x] **Step 4: Expose an authenticated read-only catalog**

In `server.mjs`, add `GET /api/agents` after user authentication and return `{ data: registry.list() }`. Do not expose package filesystem paths or system prompts.

- [x] **Step 5: Verify registry and route tests**

Run:

```bash
pnpm --filter @ai4s/server exec node --test test/agentRegistry.test.mjs test/server.test.mjs
```

Expected: PASS.

### Task 3: Bootstrap OpenCode custom agents from the same packages

**Files:**
- Modify: `OpenScience/apps/server/src/agentRegistry.mjs`
- Modify: `OpenScience/apps/server/src/runtimeManager.mjs`
- Test: `OpenScience/apps/server/test/runtimeManager.test.mjs`

- [x] **Step 1: Write the failing materialization test**

```js
const result = await syncRuntimeAgentPackages(config, project, plan);
assert.equal(result.agents, 2);
const text = await readFile(path.join(plan.xdgConfigDir, "opencode", "agents", "evimed-adr-analysis.md"), "utf8");
assert.match(text, /mode: primary/);
assert.match(text, /adr-analysis/);
```

- [x] **Step 2: Confirm RED**

Run:

```bash
pnpm --filter @ai4s/server exec node --test test/runtimeManager.test.mjs --test-name-pattern "agent packages"
```

Expected: FAIL because `syncRuntimeAgentPackages` is absent.

- [x] **Step 3: Materialize agents before process spawn**

Write each generated agent into the project-owned XDG tree with this frontmatter and the package skill instruction:

```md
---
description: EviMed drug-safety research agent
mode: primary
permission:
  bash: allow
  edit: allow
  write: allow
---

Load and follow the `adr-analysis` skill for this turn. Use only its declared tools and write outputs to its declared paths.
```

Reject symlinked sources/targets and use the existing no-follow copy/write protections.

- [x] **Step 4: Verify runtime bootstrap tests**

Run:

```bash
pnpm --filter @ai4s/server exec node --test test/runtimeManager.test.mjs
```

Expected: PASS.

### Task 4: Build the specialty catalog UI and multi-turn session binding

**Files:**
- Create: `OpenScience/apps/server/src/researchSessions.mjs`
- Modify: `OpenScience/apps/server/src/server.mjs`
- Test: `OpenScience/apps/server/test/researchSessions.test.mjs`
- Modify: `OpenScience/apps/desktop/src/lib/apiClient.ts`
- Modify: `OpenScience/apps/desktop/src/lib/runtime.ts`
- Modify: `OpenScience/apps/desktop/src/components/sidebar/Sidebar.tsx`
- Modify: `OpenScience/apps/desktop/src/app/router.tsx`
- Modify: `OpenScience/apps/desktop/src/app/routes/LiveSessionPage.tsx`
- Create: `OpenScience/apps/desktop/src/app/routes/AgentsPage.tsx`
- Test: `OpenScience/apps/desktop/src/app/routes/AgentsPage.test.tsx`
- Test: `OpenScience/apps/desktop/src/lib/runtime.store.test.ts`
- Test: `OpenScience/apps/desktop/src/app/routes/LiveSessionPage.web.test.tsx`

- [x] **Step 1: Write failing UI and binding tests**

Assert that the sidebar row appears immediately below Files, the catalog renders both packages, clicking ADR navigates to `/live?agent=adr-analysis`, the created OpenCode session is persisted as a specialist research session, and two consecutive turns both call OpenCode with `evimed-adr-analysis`.

```ts
expect(screen.getByRole("button", { name: "Research Agents" })).toBeVisible();
expect(sendPrompt).toHaveBeenNthCalledWith(2, sessionId, "follow up", "evimed-adr-analysis", expect.anything());
```

- [x] **Step 2: Confirm RED**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run src/app/routes/AgentsPage.test.tsx src/lib/runtime.store.test.ts src/app/routes/LiveSessionPage.web.test.tsx
```

Expected: FAIL because the route/catalog/binding do not exist.

- [x] **Step 3: Add catalog API types and route**

Define `WebResearchAgent` with the public registry fields and `listWebResearchAgents()` calling `/api/agents`. Add `/agents` to React Router and a “Research Agents” sidebar item directly below Files.

- [x] **Step 4: Implement stable session binding**

Store the draft selection in Zustand, but persist created-session bindings through authenticated project-scoped `GET/PUT /api/research-sessions/:sessionId`. The record contains `mode`, `agentId`, `agentVersion`, `runtimeAgent`, and timestamps; the server verifies the package against the current registry and derives runtime identity rather than trusting browser values. `startDraft(agent?)` sets the next binding; first-send persists it before the prompt; `openSession` restores it; every `sendPrompt` passes the bound runtime agent and current default model. Plain `/live` persists `mode=open-domain` with no specialty pin.

```ts
const binding = get().sessionAgents[sid] ?? get().draftAgent;
return client!.sendPrompt(sid, text, binding?.runtimeAgent, get().defaultModel);
```

- [x] **Step 5: Render the shared conversation identity**

Reuse `LiveSessionPage`; show the package name/description above the thread only when bound. Do not fork a specialty chat page or introduce workflow step forms.

- [x] **Step 6: Verify UI, store, and type tests**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run src/app/routes/AgentsPage.test.tsx src/lib/runtime.store.test.ts src/app/routes/LiveSessionPage.web.test.tsx
pnpm typecheck
```

Expected: PASS.

### Task 5: Implement the EviMed Research MCP minimum loop

**Files:**
- Create: `OpenScience/runtime/mcp/evimed-research/contracts.py`
- Create: `OpenScience/runtime/mcp/evimed-research/tools.py`
- Create: `OpenScience/runtime/mcp/evimed-research/server.py`
- Create: `OpenScience/runtime/mcp/evimed-research/test_tools.py`
- Modify: `OpenScience/apps/server/src/config.mjs`
- Modify: `OpenScience/apps/server/src/runtimeManager.mjs`
- Modify: `OpenScience/deploy/web/Dockerfile`
- Test: `OpenScience/apps/server/test/runtimeManager.test.mjs`

- [x] **Step 1: Write failing tool-contract tests**

Test `evimed_health`, `evimed_term_normalize`, `evimed_evidence_deduplicate`, `evimed_evidence_search`, `evimed_adr_signal`, and `evimed_offlabel_evidence`. Mock all external adapters; verify evidence items contain source URL/identifier, retrieved time, query, and provenance.

```js
assert.deepEqual(result, {
  ok: true,
  data: { normalized: "acetylsalicylic acid" },
  evidence: [],
  warnings: [],
  provenance: { tool: "evimed_term_normalize", version: "1" },
});
```

- [x] **Step 2: Confirm RED**

Run:

```bash
python3 -m unittest runtime/mcp/evimed-research/test_tools.py
```

Expected: FAIL because the MCP implementation does not exist.

- [x] **Step 3: Implement deterministic tools and adapter boundaries**

Keep normalization/deduplication local and deterministic. Define HTTP adapter functions for literature, ADR, and off-label evidence; return a clear `adapter_unconfigured` warning rather than fabricated evidence when an upstream URL is absent.

- [x] **Step 4: Implement MCP stdio JSON-RPC**

Support `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`; emit one JSON-RPC response per input line and put the stable envelope in MCP text content. Never write logs to stdout. Python stdlib is deliberate because the hosted runtime image includes Python 3 but not Node.js.

- [x] **Step 5: Register MCP during runtime bootstrap**

Generate the OpenCode MCP configuration in the same project-owned XDG tree. The command uses `python3` and the atomically deployed `server.py`; pass user/project/workspace scope and upstream URLs via environment variables, never manifest files or model/data-source secrets.

- [x] **Step 6: Verify tool and bootstrap tests**

Run:

```bash
python3 -m unittest runtime/mcp/evimed-research/test_tools.py
pnpm --filter @ai4s/server exec node --test test/runtimeManager.test.mjs
```

Expected: PASS.

### Task 6: Add the server-side DeepSeek gateway and runtime provider bootstrap

**Files:**
- Create: `OpenScience/apps/server/src/modelGateway.mjs`
- Modify: `OpenScience/apps/server/src/config.mjs`
- Modify: `OpenScience/apps/server/src/server.mjs`
- Modify: `OpenScience/apps/server/src/runtimeManager.mjs`
- Modify: `OpenScience/deploy/web/docker-compose.yml`
- Create: `OpenScience/apps/server/test/modelGateway.test.mjs`
- Test: `OpenScience/apps/server/test/runtimeManager.test.mjs`
- Test: `OpenScience/apps/server/test/runtimeModelProvider.test.mjs`
- Create: `OpenScience/scripts/ops/deepseek-compatibility-preflight.mjs`
- Create: `OpenScience/apps/server/test/deepseekCompatibility.test.mjs`
- Create: `OpenScience/scripts/ops/deepseek-opencode-release-gate.mjs`
- Create: `OpenScience/apps/server/test/deepseekOpenCodeReleaseGate.test.mjs`
- Modify: `OpenScience/docs/WEB_OPERATIONS_RUNBOOK.md`
- Modify: `OpenScience/docs/WEB_PRIVACY_AND_COMPLIANCE.md`

- [x] **Step 1: Write failing gateway tests with a fake upstream**

Assert that the gateway accepts only a signed, current-runtime-bound project token; sends `Authorization: Bearer <server env secret>` only to DeepSeek; forces the configured model; preserves streaming; forwards `thinking.type=enabled` and `reasoning_effort=high`; rejects unsupported paths, redirects, stale runtime tokens, and oversized/invalid bodies; and redacts upstream secrets from errors/logs.

- [x] **Step 2: Confirm RED**

Run:

```bash
pnpm --filter @ai4s/server exec node --test test/modelGateway.test.mjs
```

Expected: FAIL because the gateway is absent.

- [x] **Step 3: Implement the bounded OpenAI-compatible gateway**

Read the provider credential only from the no-follow, owner-readable file named by:

```text
OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE
OPEN_SCIENCE_DEEPSEEK_BASE_URL=https://api.deepseek.com
OPEN_SCIENCE_DEEPSEEK_MODEL=deepseek-v4-pro
```

In production, reject every provider URL except the exact credential-free root origin `https://api.deepseek.com/`. Proxy only `POST /chat/completions`, cap request and upstream-response bytes plus message/tool sizes, set an upstream timeout, disable redirects, and stream response bytes with disconnect-aware backpressure. Secret files must be regular, no-follow, and owner-only on POSIX. The signed runtime token has no fixed expiry that can interrupt an active long research run: its signature, audience, scope, issue time, and id are validated, while authorization exists only in RuntimeManager's active-runtime map. Stopping, exiting, or replacing that runtime invalidates it immediately.

- [x] **Step 4: Generate the runtime provider config**

Point OpenCode at the hosted service over a named Docker `internal: true` network and set `deepseek/deepseek-v4-pro` as the runtime default. The project XDG file may contain only the runtime-lifetime gateway token; do not copy the DeepSeek secret into the runtime XDG directory or browser. Reject a foreign pre-existing reserved `provider.deepseek` entry.

Add `pnpm preflight:deepseek`. It must use only the file-backed key and run bounded non-stream, SSE, two-or-more-iteration function-tool loop, and structured-JSON probes. CI runs the same sequence only against a fake provider; operators run the live probe explicitly with their secret file before release.

Add `pnpm preflight:deepseek:release` as the production acceptance gate. It must verify the exact OpenCode 1.17.13 binary, use the production-generated managed provider and active-runtime token, prove two real OpenCode tool executions plus exported session history and streamed structured output, and write a mode-0600 redacted receipt bound to source/config revisions. The receipt is domain-separated HMAC authenticated and freshness-bound (24 hours by default, with five minutes of future skew); both host preflight and server readiness verify it. Bounded OpenCode child processes escalate TERM to KILL and fail closed if cleanup cannot be confirmed. CI exercises the full chain against a fake provider, but fake receipts are never production-eligible.

- [x] **Step 5: Verify mocked gateway and bootstrap tests**

Run:

```bash
pnpm --filter @ai4s/server exec node --test test/modelGateway.test.mjs test/runtimeModelProvider.test.mjs test/runtimeManager.test.mjs test/deepseekCompatibility.test.mjs test/deepseekOpenCodeReleaseGate.test.mjs
```

Expected: PASS without a real API key or internet request.

### Task 7: Full acceptance and open-domain non-regression

**Files:**
- Modify: `OpenScience/apps/server/test/hosted-web.e2e.test.mjs`
- Modify: `OpenScience/PROGRESS.md`

- [x] **Step 1: Add one hosted end-to-end contract test**

Exercise login/dev session, `GET /api/agents`, select ADR, create an OpenCode session through the hosted proxy, send two prompts, and assert both mocked runtime requests carry `evimed-adr-analysis`. Separately create plain `/live` and assert its prompt has no specialty agent.

- [x] **Step 2: Run the focused E2E test**

Run:

```bash
pnpm --filter @ai4s/server test:e2e
```

Expected: PASS.

- [x] **Step 3: Run the complete quality gate**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:server
pnpm test:web:e2e
pnpm build:web
pnpm check:tauri
```

Expected: all commands exit 0; platform-specific skips are explicit and do not hide assertion failures.

- [x] **Step 4: Record the milestone**

Prepend one English line to `OpenScience/PROGRESS.md` stating that the unified open-domain/specialty-agent foundation, package registry, MCP loop, and DeepSeek gateway passed the full quality gate.

### Task 8: Add the minimum agent-runs ledger and real MCP artifact loop

**Files:**
- Create: `OpenScience/apps/server/src/agentRuns.mjs`
- Modify: `OpenScience/apps/server/src/researchSessions.mjs`
- Modify: `OpenScience/apps/server/src/server.mjs`
- Modify: `OpenScience/apps/server/src/runtimeManager.mjs`
- Modify: `OpenScience/apps/server/src/mockRuntime.mjs`
- Test: `OpenScience/apps/server/test/agentRuns.test.mjs`
- Test: `OpenScience/apps/server/test/hosted-web.e2e.test.mjs`
- Modify: `OpenScience/apps/desktop/src/lib/apiClient.ts`
- Modify: `OpenScience/apps/desktop/src/lib/runtime.ts`
- Test: `OpenScience/apps/desktop/src/lib/apiClient.test.ts`
- Test: `OpenScience/apps/desktop/src/lib/runtime.store.test.ts`
- Test: `OpenScience/apps/desktop/src/lib/runtime.web.test.ts`
- Modify: `OpenScience/scripts/ops/deepseek-opencode-release-gate.mjs`
- Test: `OpenScience/apps/server/test/deepseekOpenCodeReleaseGate.test.mjs`

- [x] **Step 1: Add a project-scoped append-only run ledger**

Keep the append-only ledger in the project metadata directory, outside the browser-writable workspace. Record server-derived session mode, immutable agent id/version/runtime identity, configured model, idempotent dispatch identity/status, stable baseline message cursor, running/terminal status, timestamps, duration, bounded stable error codes, and normalized verified artifact paths. Map absolute tool paths from the runtime-visible workspace root (for example Docker `/workspace`) to the host workspace before boundary, existence, regular-file, and no-follow validation. Bound storage, refuse symlinks, enforce one running run per session, and reject cross-project or illegal state transitions.

- [x] **Step 2: Connect turn lifecycle without storing prompts**

Expose only authenticated project-scoped `GET /api/agent-runs` and atomic `POST /api/agent-runs/dispatch` to the browser; there is no public start-only or terminal mutation endpoint. The dispatch endpoint validates the immutable research-session binding, reads a stable OpenCode history cursor fail-closed before creating a run, reserves an idempotent dispatch id, and submits the prompt through the existing RuntimeManager/OpenCode `prompt_async` protocol. A definite pre-acceptance rejection terminally fails the run; a confirmed 2xx is persisted as accepted, so a lost browser response is recovered through GET and never resent; connection-level ambiguity is persisted as unknown and monitored without retry. A bounded server monitor reads only an already-running runtime, owns every terminal transition, recovers persisted runs without waking stopped runtimes, and closes each run exactly once and with awaited failed/canceled semantics on workload-token refresh failure, quota guard, idle timeout, explicit stop, or unexpected exit. Browser idle/error/interrupt events only refresh the trusted ledger.

- [x] **Step 3: Prove the real OpenCode-to-MCP artifact path**

Run the bundled OpenCode 1.17.13 with production-generated MCP/provider configuration. The prompt must describe the medical task without naming exact tool or artifact identifiers. The fake model must select the available normalization MCP tool, consume its provenance-bearing result, then invoke the real write tool to create a workspace artifact. Assert physical artifact content, completed structured tool history, actual gateway/provider/SSE telemetry, gateway-only provider calls, and cleanup; prompt strings alone never count as release evidence.

- [x] **Step 4: Run the expanded acceptance gate**

```bash
pnpm --filter @ai4s/server exec node --test test/agentRuns.test.mjs test/deepseekOpenCodeReleaseGate.test.mjs
pnpm --filter @ai4s/desktop exec vitest run src/lib/runtime.web.test.ts
pnpm test:server
pnpm test
python3 -m unittest discover -s runtime/mcp/evimed-research/test -p 'test_*.py'
pnpm test:web:e2e
pnpm typecheck
pnpm lint
pnpm build:web
```

Expected: PASS, with no real DeepSeek key or network request.

## Final acceptance matrix

- Open-domain `/live` remains unpinned and passes the existing OpenScience tests.
- “Research Agents” is below Files and opens a screenshot-aligned list.
- ADR and off-label packages are defined once and validated at startup.
- Specialty conversations remain multi-turn and pin the same OpenCode custom agent every turn.
- Runtime skills, custom agents, MCP, and provider configuration are generated before OpenCode starts.
- DeepSeek credentials stay server-side; no key appears in source, browser payloads, generated XDG files, logs, or tests.
- MCP tools return evidence/provenance envelopes and never fabricate upstream results.
- Every hosted open-domain or specialty turn has a server-derived run identity, terminal state, duration, and normalized artifact paths without storing prompts or tool payloads.
- No clinical signing, validation bureaucracy, duplicate workflow DSL, complex RBAC, or legacy migration is introduced.
- All type, lint, unit, server, E2E, web-build, and Tauri checks pass.

## Final verification record

Completed on 2026-07-17 after independent code review. The final root-run gate passed 423 server tests with one explicit platform skip, 442 desktop tests, 22 Python MCP tests, hosted E2E, the bundled OpenCode 1.17.13 fake-upstream release chain, TypeScript, ESLint, the Web production build, Tauri `cargo check`, 57 hosted-compliance checks, production dependency audit, Docker Compose rendering, and repository long-form API-key scanning. No real DeepSeek credential or live DeepSeek request was used during development verification; production remains fail-closed until an operator supplies file-backed secrets and a fresh signed non-fake release receipt.
