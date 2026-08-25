/**
 * `@evimed/harness-port` — the anti-corruption layer.
 *
 * Hidden knowledge: every point at which EviMed touches DeepSeek Harness.
 * DSH states plainly that it makes no compatibility promises before its first
 * tagged release and will "rename or repackage freely"; eleven days produced
 * ten npm versions. The response is not to hope, it is to make the contact
 * surface one package: this one. `@deepseek-ai/*` may be imported here and
 * nowhere else — including in a JSDoc `import()` type, which ESLint and a CI
 * grep both enforce — and every seam enters through exactly one export below.
 *
 * The exports own their own shapes rather than forwarding DSH's, because a
 * rename table only survives renames. `seam-manifest.json` is the single source
 * the port's exports, the startup probe, the lint allow-list, the contract
 * tests and the control plane's method allow-list all derive from.
 *
 * @module @evimed/harness-port
 */

import SEAMS from './seam-manifest.json' with { type: 'json' }
import {
  KNOWN_TURN_END_KINDS,
  toArgs,
  toSessionEvent,
  toSessionRef,
  toStepInfo,
  toSubagentOutcome,
  toToolCall,
  toToolOutcome,
  toTurnEnd,
  toUsage,
} from './src/convert.mjs'

export { SEAMS }
export {
  KNOWN_TURN_END_KINDS,
  toArgs,
  toSessionEvent,
  toSessionRef,
  toStepInfo,
  toSubagentOutcome,
  toToolCall,
  toToolOutcome,
  toTurnEnd,
  toUsage,
}

/**
 * Lazily imported DSH modules.
 *
 * Static `import` of `@deepseek-ai/*` at module load would make this package
 * unloadable outside a harness process — and the control plane, the contract
 * tests and the SKILL rewrite script all import it for its manifest and its
 * conversion functions without a harness anywhere. So the harness modules load
 * on first use, and a missing one produces a named error rather than a module
 * resolution failure three frames up.
 * @type {Map<string, Promise<any>>}
 */
const loaded = new Map()

/**
 * @param {string} specifier
 * @returns {Promise<any>}
 */
export async function loadHarnessModule(specifier) {
  if (!Object.prototype.hasOwnProperty.call(SEAMS.packages, specifier)) {
    throw new Error(`evimed: ${specifier} is not listed in seam-manifest.packages`)
  }
  if (!loaded.has(specifier)) {
    loaded.set(specifier, import(specifier).catch((error) => {
      loaded.delete(specifier)
      throw new Error(`evimed: seam package ${specifier} is unavailable: ${error?.message ?? error}`)
    }))
  }
  return loaded.get(specifier)
}

/** Test seam: lets the consistency suite install fakes without a harness install. */
export function __setHarnessModule(specifier, value) {
  loaded.set(specifier, Promise.resolve(value))
}

/* ------------------------------------------------------------------ tools */

/**
 * Defines a model-facing tool from the port's own spec shape.
 *
 * Every EviMed tool answers in one envelope — `{ok, code?, data?, issues?}` —
 * so the model learns one failure shape instead of eight (§14 rule 15). The
 * envelope is applied here rather than in each tool, which is also why the
 * output schema is written once, with `additionalProperties: true` on the
 * object root (a community-documented trap: a closed object root makes the
 * adapter drop fields silently).
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, any>,
 *   dataSchema?: Record<string, any>,
 *   timeoutMs?: number,
 *   concurrencySafe?: boolean,
 *   execute: (args: Record<string, any>, call: import('./src/types.mjs').ToolCall) => Promise<{ok: boolean, code?: string, data?: any, issues?: any[], concludeTurn?: boolean}>,
 * }} spec
 * @returns {Promise<any>} a registry-ready DSH tool definition
 */
export async function defineTool(spec) {
  const { defineTool: dshDefineTool } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  return dshDefineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.concurrencySafe === undefined ? {} : { isConcurrencySafe: () => Boolean(spec.concurrencySafe) }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          data: { type: 'json' },
          issues: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderEnvelope(value) }],
    },
    async execute(args, exec) {
      const call = toToolCall(exec)
      const result = await spec.execute(/** @type {Record<string, any>} */ (args ?? {}), call)
      if (result?.concludeTurn && result.ok) exec.concludeTurn()
      return {
        ok: Boolean(result?.ok),
        ...(result?.code ? { code: result.code } : {}),
        ...(result?.data === undefined ? {} : { data: result.data }),
        ...(result?.issues ? { issues: result.issues } : {}),
      }
    },
  })
}

/**
 * The one text projection of the envelope the model reads. Kept here so the
 * model sees the same layout from every EviMed tool.
 * @param {any} value
 * @returns {string}
 */
export function renderEnvelope(value) {
  const envelope = value && typeof value === 'object' ? value : { ok: false, code: 'invalid_result' }
  const lines = [envelope.ok ? 'ok' : `failed: ${envelope.code ?? 'unknown'}`]
  if (envelope.data !== undefined) lines.push(JSON.stringify(envelope.data, null, 2))
  for (const issue of Array.isArray(envelope.issues) ? envelope.issues : []) {
    const record = issue && typeof issue === 'object' ? issue : { message: String(issue) }
    const where = record.path ? ` [${record.path}${record.line ? `:${record.line}` : ''}]` : ''
    lines.push(`- (${record.severity ?? 'required'}) ${record.code ?? ''}${where} ${record.message ?? ''}`.trim())
  }
  return lines.join('\n')
}

/**
 * Registers a tool in the calling scope.
 * @param {any} ctx @param {any} tool @returns {() => void}
 */
export function registerTool(ctx, tool) {
  return ctx.tools.register(tool)
}

/**
 * The monotonic, final refusal. Reserved for policy: an attempt ceiling, a
 * budget, a path guard. A business verdict is a return value, never this.
 * @param {any} ctx
 * @param {(call: import('./src/types.mjs').ToolCall) => string | undefined} fn
 * @returns {() => void}
 */
export function guardTools(ctx, fn) {
  return ctx.tools.guard((exec) => fn(toToolCall(exec)))
}

/* ----------------------------------------------------------------- events */

/**
 * Tool policy (`tools/pre-execute`). A waterfall listener that forgets to
 * delegate short-circuits the whole pipeline, so delegation happens here once
 * rather than in every plugin (§14 rule 31).
 * @param {any} ctx
 * @param {(call: import('./src/types.mjs').ToolCall) => Promise<import('./src/types.mjs').PolicyDecision> | import('./src/types.mjs').PolicyDecision} fn
 * @returns {() => void}
 */
export function onToolPolicy(ctx, fn) {
  return ctx.on(SEAMS.events.toolPolicy, async (exec, next) => {
    const decision = await fn(toToolCall(exec))
    if (decision.allow === true) return next()
    // The refusal carries a machine code as well as a sentence: the code is what
    // the ledger records, the sentence is what the model is told.
    const refusal = /** @type {{ allow: false, code: string, reason: string }} */ (decision)
    return { kind: 'deny', reason: `${refusal.code}: ${refusal.reason}` }
  })
}

/**
 * Around-dispatch wrapping (`tools/execute`): timeouts, retries, metering.
 * @param {any} ctx
 * @param {(call: import('./src/types.mjs').ToolCall, proceed: () => Promise<any>) => Promise<any>} fn
 * @returns {() => void}
 */
export function onToolWrap(ctx, fn) {
  return ctx.on(SEAMS.events.toolWrap, async (exec, next) => fn(toToolCall(exec), next))
}

/**
 * Read-only observation of the final outcome (`tools/result`). A listener here
 * can never change what the model sees, which is why evidence ingestion lives
 * on it — the ledger may not be able to alter the run it is recording.
 * @param {any} ctx
 * @param {(call: import('./src/types.mjs').ToolCall, outcome: import('./src/types.mjs').ToolOutcome) => void} fn
 * @returns {() => void}
 */
export function onToolObserved(ctx, fn) {
  return ctx.on(SEAMS.events.toolObserved, (exec, result) => fn(toToolCall(exec), toToolOutcome(result)))
}

/**
 * Every durable session event, normalized.
 * @param {any} ctx
 * @param {(session: import('./src/types.mjs').SessionRef, event: import('./src/types.mjs').NormalizedSessionEvent) => void} fn
 * @returns {() => void}
 */
export function onSessionEvent(ctx, fn) {
  return ctx.on(SEAMS.events.sessionEvent, (session, event) => fn(toSessionRef(session), toSessionEvent(event)))
}

/**
 * Turn ends only, already classified.
 * @param {any} ctx
 * @param {(session: import('./src/types.mjs').SessionRef, end: import('./src/types.mjs').TurnEnd, event: import('./src/types.mjs').NormalizedSessionEvent) => void} fn
 * @returns {() => void}
 */
export function onTurnEnd(ctx, fn) {
  return onSessionEvent(ctx, (session, event) => {
    if (event.type !== 'turn/end') return
    fn(session, toTurnEnd(event), event)
  })
}

/**
 * Session lifecycle start. The only place the run brief may be injected: a
 * later injection would race the first model request.
 * @param {any} ctx
 * @param {(agent: any, source: string) => void} fn
 * @returns {() => void}
 */
export function onSessionStart(ctx, fn) {
  return ctx.on(SEAMS.events.sessionStart, (payload) => fn(payload?.agent, String(payload?.source ?? '')))
}

/**
 * Per-step admission (`agent/pre-step`). Rejecting stops the step; the caller
 * is expected to have injected an explanation first, or the model learns
 * nothing from the refusal.
 * @param {any} ctx
 * @param {(step: import('./src/types.mjs').StepInfo, payload: any) => Promise<import('./src/types.mjs').StepDecision> | import('./src/types.mjs').StepDecision} fn
 * @param {(payload: any) => { first: boolean, root: boolean, usageSoFar?: any }} classify
 * @returns {() => void}
 */
export function onPreStep(ctx, fn, classify) {
  return ctx.on(SEAMS.events.preStep, async (payload, next) => {
    const decision = await fn(toStepInfo(payload, classify(payload)), payload)
    if (decision.allow) return next()
    return { kind: 'reject' }
  })
}

/**
 * Last chance to push one more step before a turn closes.
 * @param {any} ctx
 * @param {(agent: any, turn: number) => Promise<void> | void} fn
 * @returns {() => void}
 */
export function onTurnStopping(ctx, fn) {
  return ctx.on(SEAMS.events.turnStopping, async (payload) => fn(payload?.agent, Number(payload?.turn ?? 0)))
}

/**
 * Durable storage changes for the plugin's own domain.
 * @param {any} ctx
 * @param {(change: { domain: string, table: string, key: string }) => void} fn
 * @returns {() => void}
 */
export function onDomainChanged(ctx, fn) {
  return ctx.on(SEAMS.events.domainChanged, (change) => fn({
    domain: String(change?.domain ?? ''),
    table: String(change?.table ?? ''),
    key: String(change?.key ?? ''),
  }))
}

/* --------------------------------------------------------------- surfaces */

/**
 * Registers a prompt section. Orders 100–199 are the tool-guidance band by DSH
 * convention, which is where our orchestration guidance belongs.
 * @param {any} ctx @param {import('./src/types.mjs').PromptSection} section
 * @returns {() => void}
 */
export function registerSection(ctx, section) {
  return ctx.systemPrompt.section({ name: section.name, order: section.order, text: section.text })
}

/**
 * Makes text model-visible by logging it. Not a side channel: it becomes a
 * first-class `user/message` with a plugin source, which is what preserves the
 * runtime's "model-visible ⟺ logged" invariant and lets the UI show exactly
 * what the system injected (§18.2).
 * @param {any} agent @param {string} text @param {string} plugin
 * @returns {void}
 */
export function injectContext(agent, text, plugin) {
  agent.inject({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  })
}

/**
 * Registers a runtime skill (used for the capsule's distilled methods, which
 * are read from a deployment-owned read-only directory rather than materialized
 * into the workspace — a workspace file would be an upload away from being an
 * instruction).
 * @param {any} ctx @param {{ name: string, description: string, content: string, whenToUse?: string }} skill
 * @returns {() => void}
 */
export function registerSkill(ctx, skill) {
  return ctx.skills.register({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    // `whenToUse` is a declared field of `SkillSummary`, and the catalog the
    // model reads surfaces it as routing guidance. Under `metadata` it is
    // parsed-frontmatter cargo the catalog never shows, so the skill was
    // advertised with no statement of when to reach for it.
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
  })
}

/**
 * DSH's public skill-name grammar. Kept as a local copy because
 * `registerSkill` must stay synchronous (its return value is the effect's
 * disposer) and the harness modules load lazily; `test/port.test.mjs` pins
 * this copy against the kernel's own `isSkillName` so it cannot drift.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Produce a registrable skill name from a name we do not control.
 *
 * `skills.register()` *throws* on a name outside the grammar, and the capsule
 * registers inside `ctx.effect` during `apply` — so one user method named with
 * a colon, a capital or a Chinese character does not skip that skill, it fails
 * the plugin that owns memory recall. The prefix `capsule:<name>` was itself
 * outside the grammar, so the throw was unconditional for any user who had
 * distilled even one method.
 *
 * Normalization follows the kernel's own precedent for MCP public names: when
 * slugging changes the identity, an 8-hex digest is appended so two distinct
 * methods can never collapse into one registration (a collapse reads as "my
 * method is missing", which is exactly the failure memory must not have).
 * @param {string} raw   the user's own name for the method
 * @param {string} prefix  kebab-case namespace, e.g. `capsule`
 * @returns {string}
 */
export function toSkillName(raw, prefix) {
  const verbatim = `${prefix}-${raw}`
  if (SKILL_NAME.test(verbatim)) return verbatim
  const slug = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  let digest = 0
  for (const ch of String(raw)) digest = (Math.imul(digest, 31) + ch.codePointAt(0)) >>> 0
  const suffix = digest.toString(16).padStart(8, '0')
  return slug ? `${prefix}-${slug}-${suffix}` : `${prefix}-${suffix}`
}

/* -------------------------------------------------------------- subagents */

/**
 * Starts one delegated child.
 * @param {any} ctx
 * @param {import('./src/types.mjs').SubagentRequest} request
 * @param {any} parent
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
export function startSubagent(ctx, request, parent, signal) {
  return ctx.subagents.start(SEAMS.subagentProviders.spawn, {
    label: request.label,
    prompt: [{ type: 'text', text: request.prompt }],
    parent,
    signal,
    outputSchema: request.outputSchema,
    toolFilter: { allow: [...request.tools] },
    persona: request.persona,
    ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
  })
}

/* ---------------------------------------------------------------- storage */

/**
 * Opens the plugin's own durable domain. The only sanctioned home for plugin
 * state; the session log is not one (§14 rule 32).
 *
 * The spec is written in the port's own field vocabulary rather than in zod,
 * which is DSH's current choice for record schemas. That indirection is the
 * whole point of the package: a plugin that wrote zod schemas would have to be
 * rewritten if DSH moved to another validator, and there are seven of them.
 *
 * @param {any} ctx
 * @param {{ name: string, version: number, tables: Record<string, Record<string, FieldType>> }} spec
 * @returns {Promise<any>}
 */
export async function openDomain(ctx, spec) {
  const { defineDomain, domainTable } = await loadHarnessModule('@deepseek-ai/dsh-storage-domain')
  const z = await loadZod()
  /** @type {Record<string, any>} */
  const tables = {}
  for (const [table, fields] of Object.entries(spec.tables)) {
    tables[table] = domainTable(recordSchema(z, fields))
  }
  return ctx.storageDomain.open(defineDomain({ name: spec.name, version: spec.version, tables }))
}

/**
 * The field vocabulary a domain table is declared in.
 * @typedef {'string'|'number'|'boolean'|'json'|'string[]'|'string?'|'number?'|'json?'} FieldType
 */

/**
 * @param {any} z
 * @param {Record<string, FieldType>} fields
 * @returns {any}
 */
function recordSchema(z, fields) {
  /** @type {Record<string, any>} */
  const shape = {}
  for (const [field, type] of Object.entries(fields)) {
    shape[field] = fieldSchema(z, type)
  }
  return z.object(shape)
}

/**
 * @param {any} z @param {FieldType} type @returns {any}
 */
function fieldSchema(z, type) {
  switch (type) {
    case 'string': return z.string()
    case 'string?': return z.string().optional()
    case 'number': return z.number()
    case 'number?': return z.number().optional()
    case 'boolean': return z.boolean()
    case 'string[]': return z.array(z.string())
    case 'json?': return z.unknown().optional()
    case 'json':
    default: return z.unknown()
  }
}

/**
 * zod reaches us as a dependency of the storage-domain package. Loading it by
 * bare specifier keeps the version resolution with the harness rather than
 * pinning a second copy in our tree.
 * @returns {Promise<any>}
 */
async function loadZod() {
  // Loaded by bare specifier so the version resolution stays with the harness
  // that owns it; the dynamic form also keeps this package loadable outside a
  // harness install, which the control plane and the contract tests both need.
  const specifier = 'zod'
  const mod = await import(/* @vite-ignore */ specifier)
  return mod.z ?? mod.default ?? mod
}

/**
 * Plugin configuration schemas. Re-exported so a plugin never depends on
 * schemastery directly (§5.5). `Config` is read at plugin module load, so the
 * plugins await this at the top level.
 * @returns {Promise<any>}
 */
export async function configSchema() {
  const mod = await loadHarnessModule('@deepseek-ai/schemastery')
  return mod.default ?? mod
}

/* ----------------------------------------------------------- workspace IO */

/**
 * File reads and writes go through `ctx.fs`, never `node:fs`: the sandbox
 * policy, the stale-version guard and the remote-execution seam all live on the
 * service, and a plugin that reaches around it is unfenced by construction
 * (§14 rule 36).
 *
 * A read returns null rather than throwing. Every caller here is asking "is
 * there a copy of X" and has a defined answer for "no"; making absence an
 * exception would put a `try` around each of them (ch.10).
 *
 * @param {any} ctx @param {string} baseDir @param {string} relativePath @param {AbortSignal} [signal]
 * @returns {Promise<string | null>}
 */
export async function readFileAt(ctx, baseDir, relativePath, signal) {
  const fs = ctx.get('fs')
  if (!fs) return null
  try {
    const target = await fs.resolve(relativePath, { cwd: baseDir, signal })
    return await fs.readText(target, signal)
  } catch {
    return null
  }
}

/**
 * @param {any} ctx @param {string} baseDir @param {string} relativePath @param {AbortSignal} [signal]
 * @returns {Promise<{ name: string, directory: boolean }[]>}
 */
export async function listDirAt(ctx, baseDir, relativePath, signal) {
  const fs = ctx.get('fs')
  if (!fs) return []
  try {
    const target = await fs.resolve(relativePath, { cwd: baseDir, signal })
    const entries = await fs.listDir(target, signal)
    return entries.map((entry) => ({
      name: String(entry?.name ?? ''),
      directory: Boolean(entry?.isDirectory ?? entry?.directory ?? entry?.type === 'directory'),
    })).filter((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * A write, on the other hand, throws: a caller that asked for something to be
 * persisted and got silence back cannot tell success from failure.
 * @param {any} ctx @param {string} baseDir @param {string} relativePath @param {string} content @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
export async function writeFileAt(ctx, baseDir, relativePath, content, signal) {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('evimed: ctx.fs is unavailable, cannot write')
  const target = await fs.resolve(relativePath, { cwd: baseDir, signal })
  await fs.writeText(target, content, undefined, signal)
  return true
}

/** Kept for the projection writer, whose failure is isolated by design. */
export const readWorkspaceFile = readFileAt
export const writeWorkspaceFile = writeFileAt

/* ------------------------------------------------------------------ probe */

/**
 * The startup self-check (§5.6).
 *
 * Two levels, because the two failures are not alike. A missing gate-level seam
 * means the deployment cannot enforce what it promises, so it must not start; a
 * missing enhancement means one capability is off, which the run should survive
 * with a named counter and a visible notice.
 *
 * The check that matters most is the full-pipeline probe: DSH renames events
 * freely, and a renamed event does not error — the listener simply never fires.
 * That is a silent failure of a gate, which is the worst kind, so the probe
 * registers a real tool, executes it, and asserts both the policy seam and the
 * observation seam fired.
 *
 * @param {any} ctx
 * @param {{ dshVersion?: string, requiredEnforcement?: 'full'|'partial' }} options
 * @returns {Promise<{ fatal: string[], degraded: string[], checked: string[] }>}
 */
export async function probeSeams(ctx, options = {}) {
  /** @type {string[]} */
  const fatal = []
  /** @type {string[]} */
  const degraded = []
  /** @type {string[]} */
  const checked = []

  for (const key of SEAMS.services.required) {
    checked.push(`service:${key}`)
    if (!ctx.get(key)) fatal.push(`seam missing: ctx.${key}`)
  }
  for (const key of SEAMS.services.optional) {
    checked.push(`service:${key}?`)
    if (!ctx.get(key)) degraded.push(`optional seam missing: ctx.${key}`)
  }

  if (options.dshVersion && options.dshVersion !== SEAMS.dsh) {
    fatal.push(`dsh version ${options.dshVersion} != seam-manifest.dsh ${SEAMS.dsh}`)
  }

  if (!fatal.length) {
    const pipeline = await probeToolPipeline(ctx)
    checked.push('pipeline:tools')
    if (!pipeline.policyFired) fatal.push(`seam silent: ${SEAMS.events.toolPolicy} never fired`)
    if (!pipeline.observedFired) fatal.push(`seam silent: ${SEAMS.events.toolObserved} never fired`)
    if (pipeline.error) fatal.push(`tool pipeline probe failed: ${pipeline.error}`)
  }

  const sandbox = await probeSandbox(ctx, options.requiredEnforcement ?? 'full')
  checked.push('sandbox')
  if (sandbox.error) fatal.push(sandbox.error)

  return { fatal, degraded, checked }
}

/**
 * @param {any} ctx
 * @returns {Promise<{ policyFired: boolean, observedFired: boolean, error: string | null }>}
 */
async function probeToolPipeline(ctx) {
  const probeName = 'evimed_seam_probe'
  let policyFired = false
  let observedFired = false
  /** @type {(() => void)[]} */
  const disposers = []
  try {
    disposers.push(ctx.on(SEAMS.events.toolPolicy, async (exec, next) => {
      if (String(exec?.name) === probeName) policyFired = true
      return next()
    }))
    disposers.push(ctx.on(SEAMS.events.toolObserved, (exec) => {
      if (String(exec?.name) === probeName) observedFired = true
    }))
    const tool = await defineTool({
      name: probeName,
      description: 'Internal startup probe. Never advertised to a model.',
      parameters: {},
      execute: async () => ({ ok: true, data: { probe: true } }),
    })
    disposers.push(ctx.tools.register(tool))
    await ctx.tools.execute({ callId: `probe-${Date.now()}`, name: probeName, arguments: {}, signal: AbortSignal.timeout(5000) })
    return { policyFired, observedFired, error: null }
  } catch (error) {
    return { policyFired, observedFired, error: error?.message ?? String(error) }
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // A disposer that throws must not mask the probe's own verdict.
      }
    }
  }
}

/**
 * Runs one empty command through the sandbox. In a container bwrap is
 * unavailable (it needs an unprivileged user namespace, which Docker's default
 * seccomp and Ubuntu's AppArmor both refuse), so the chain falls to Landlock —
 * and if Landlock is unavailable too, the bash tool fails closed while the
 * runtime still looks healthy. That combination is why this check exists.
 * @param {any} ctx @param {'full'|'partial'} required
 * @returns {Promise<{ error: string | null, enforcement: string }>}
 */
async function probeSandbox(ctx, required) {
  const shell = ctx.get('shell')
  if (!shell) return { error: 'seam missing: ctx.shell', enforcement: 'none' }
  // `run()` takes a spec from `resolve()`, never a raw request — the executor's
  // own documentation says so, and the sandboxing subclass is where it bites:
  // `resolve()` is what fills `sandboxPolicy` from `ctx.sandboxPolicy`, and
  // `run()` destructures that policy without a default. Calling `run()`
  // directly crashed the probe on "Cannot destructure property 'mode' of
  // 'policy'" — a probe written to prove the seams work, failing on the seam it
  // was using to test them, because until a real container booted nothing had
  // ever executed it.
  if (typeof shell.resolve !== 'function') {
    return { error: 'seam missing: ctx.shell.resolve', enforcement: 'none' }
  }
  try {
    const spec = shell.resolve({ command: 'true', signal: AbortSignal.timeout(10_000) })
    const result = await shell.run(spec)
    // The harness reports this as `{ mode, denied, enforcement?, runnerFailed? }`
    // under `sandbox`; the flat read is a fallback for a shape that moves.
    const sandbox = result?.sandbox && typeof result.sandbox === 'object' ? result.sandbox : {}
    const enforcement = String(result?.enforcement ?? sandbox.enforcement ?? 'unknown')
    // `enforcement` is optional in the harness's own type, so its absence has to
    // read as unknown rather than as satisfied — a probe that treats a missing
    // field as a pass is the one that certifies exactly the broken deployment.
    if (sandbox.runnerFailed === true) {
      // The precise shape of G2: the backend never launched, so the bash tool
      // will refuse every command, and nothing else about the runtime looks
      // wrong. Reported separately from the enforcement level because the
      // remedy is different — a host prerequisite, not a profile setting.
      return { error: `sandbox runner failed to launch (enforcement "${enforcement}"); the bash tool will refuse every command`, enforcement }
    }
    if (sandbox.denied === true) {
      return { error: 'the sandbox denied a no-op command; its policy does not match this workspace', enforcement }
    }
    if (required === 'full' && enforcement !== 'full') {
      return { error: `sandbox enforcement is "${enforcement}", this profile requires "full"`, enforcement }
    }
    return { error: null, enforcement }
  } catch (error) {
    return { error: `sandbox probe failed: ${error?.message ?? error}`, enforcement: 'none' }
  }
}
