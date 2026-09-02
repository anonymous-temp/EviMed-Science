/**
 * `capability.yaml` — the only definition of a capability.
 *
 * Hidden knowledge: what a capability has to declare before the orchestrator
 * may delegate to it. The manifest replaced `agent.yaml` and grew four fields
 * (`whenToUse`, `persona`, `produces`, `safetyClass`) because the orchestrator
 * now composes capabilities freely instead of being routed to one: it needs a
 * one-line "delegate to me when…", a persona for the child, an explicit list of
 * what the capability produces and under which contract, and a safety class.
 *
 * This module validates a parsed object. It never reads a file — the build-time
 * generator and the control plane both hand it parsed YAML, keeping the domain
 * free of `node:fs` (§14 rule 3).
 */

import { isContractKind } from './contractKinds.mjs'
import { SAFETY_CLASSES } from './contractKinds.mjs'
import { MCP_TOOL_NAMES, SOCKET_TOOL_NAME_LIST, mcpToolBaseName, mcpToolName } from './toolNames.mjs'

/**
 * Tools every delegated child gets regardless of its manifest (§9.5 step 3).
 *
 * Every name here must be a tool the kernel has already registered on the
 * inherited plane when the child's composition is applied, because this list
 * becomes `toolFilter.allow` and the kernel resolves it with
 * `tools.restrict()`, which **throws on a name it does not know** rather than
 * ignoring it. An unknown name therefore does not narrow a child's tools; it
 * turns every delegation into an exception.
 *
 * `report` used to be here and was exactly that defect. It is registered by
 * `@deepseek-ai/dsh-tool-subagent-report` into a child's *own* layer, and two
 * independent things put it out of reach: own-layer names are excluded from
 * `restrictableNames`, and the kernel applies the composition *before* it runs
 * the continuable-setup contributions that would register it
 * (`dsh-subagent`: `applyChildComposition(...)` then `setupRegistry.apply(...)`).
 * Our result channel was never `report` anyway — it is
 * `DELEGATION_REPORT_SCHEMA` through `outputSchema`.
 */
export const DELEGATION_BASE_TOOLS = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'skill',
  'evimed_submit_deliverable',
])

/**
 * Tool names the kernel registers globally, which is the set
 * `DELEGATION_BASE_TOOLS` may draw from.
 *
 * Derived from the plugin rows our preset mounts: `tool-fs` publishes
 * read/write/edit, `tool-fs-search` glob/grep, `tool-skill` skill, `tool-bash`
 * bash, `tool-subagent` subagent, `tool-ask-user` ask_user. Kept as data next
 * to the list it constrains so that adding a name to one without the other is
 * a test failure rather than a runtime exception at the first delegation.
 * @type {ReadonlySet<string>}
 */
export const KERNEL_GLOBAL_TOOL_NAMES = Object.freeze(new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'skill',
  'bash',
  'subagent',
  'ask_user',
]))

/** Autopilot task types a capability may declare (§24.3). */
export const AUTOPILOT_TASK_TYPES = Object.freeze([
  'literature-sentinel',
  'evidence-update',
  'data-prospecting',
  'hypothesis-suggestion',
  'writing-pipeline',
  'signal-monitoring',
])

/** Cost classes used by the daily allocator. */
export const COST_CLASSES = Object.freeze(['low', 'medium', 'high'])

/** @typedef {{ code: string, message: string, field?: string }} ManifestIssue */

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

/**
 * @param {unknown} value
 * @returns {{ ok: boolean, manifest: Record<string, any> | null, issues: ManifestIssue[] }}
 */
export function validateCapabilityManifest(value) {
  /** @type {ManifestIssue[]} */
  const issues = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, manifest: null, issues: [{ code: 'capability_invalid', message: 'capability.yaml must be a mapping.' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const id = String(raw.id ?? '').trim()
  if (!ID_PATTERN.test(id)) issues.push({ code: 'capability_invalid', message: `capability id "${id}" must match ${ID_PATTERN}.`, field: 'id' })
  const version = String(raw.version ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) issues.push({ code: 'capability_invalid', message: 'version must be semver x.y.z.', field: 'version' })
  const title = String(raw.title ?? '').trim()
  if (!title) issues.push({ code: 'capability_invalid', message: 'title is required.', field: 'title' })
  const description = String(raw.description ?? '').trim()
  if (!description) issues.push({ code: 'capability_invalid', message: 'description is required — it is the catalogue line the orchestrator reads.', field: 'description' })
  const whenToUse = String(raw.whenToUse ?? '').trim()
  if (!whenToUse) issues.push({ code: 'capability_invalid', message: 'whenToUse is required — one sentence saying when to delegate here.', field: 'whenToUse' })
  const persona = String(raw.persona ?? '').trim()
  if (!persona) issues.push({ code: 'capability_invalid', message: 'persona is required — the delegated child runs with it.', field: 'persona' })

  const skills = toStringArray(raw.skills)
  if (!skills.length) issues.push({ code: 'capability_invalid', message: 'skills[] is required — delegation pre-injects them, which is what makes skillsLoaded true by construction.', field: 'skills' })

  const tools = toStringArray(raw.tools)
  for (const tool of tools) {
    if (SOCKET_TOOL_NAME_LIST.includes(tool)) continue
    if (DELEGATION_BASE_TOOLS.includes(tool)) continue
    if (MCP_TOOL_NAMES.includes(tool)) continue
    const base = mcpToolBaseName(tool)
    if (base) {
      issues.push({
        code: 'capability_invalid',
        message: `tool "${tool}" uses the legacy spelling; write "${mcpToolName(base)}".`,
        field: 'tools',
      })
      continue
    }
    issues.push({ code: 'capability_invalid', message: `unknown tool "${tool}".`, field: 'tools' })
  }

  const produces = Array.isArray(raw.produces) ? raw.produces : []
  if (!produces.length) issues.push({ code: 'capability_invalid', message: 'produces[] is required.', field: 'produces' })
  /** @type {Record<string, any>[]} */
  const normalizedProduces = []
  const seenKinds = new Set()
  for (const entry of produces) {
    const item = /** @type {Record<string, unknown>} */ (entry ?? {})
    const contractKind = String(item.contractKind ?? '').trim()
    if (!isContractKind(contractKind)) {
      issues.push({ code: 'contract_kind_unknown', message: `unknown contract kind "${contractKind}".`, field: 'produces' })
      continue
    }
    if (seenKinds.has(contractKind)) {
      issues.push({ code: 'capability_invalid', message: `duplicate contract kind "${contractKind}".`, field: 'produces' })
      continue
    }
    seenKinds.add(contractKind)
    const outputs = Array.isArray(item.outputs) ? item.outputs : []
    /** @type {{ path: string, required: boolean }[]} */
    const normalizedOutputs = []
    for (const output of outputs) {
      const record = /** @type {Record<string, unknown>} */ (output ?? {})
      const path = String(record.path ?? '').trim()
      if (!path || path.includes('..') || path.startsWith('/')) {
        issues.push({ code: 'capability_invalid', message: `output path "${path}" must be a relative path inside the deliverable directory.`, field: 'produces' })
        continue
      }
      normalizedOutputs.push({ path, required: record.required !== false })
    }
    if (!normalizedOutputs.length) {
      issues.push({ code: 'capability_invalid', message: `contract kind "${contractKind}" declares no outputs.`, field: 'produces' })
    }
    normalizedProduces.push({
      contractKind,
      outputs: normalizedOutputs,
      checks: toStringArray(item.checks),
    })
  }

  const safetyClass = String(raw.safetyClass ?? 'general').trim()
  if (!SAFETY_CLASSES.includes(safetyClass)) {
    issues.push({ code: 'capability_invalid', message: `unknown safetyClass "${safetyClass}".`, field: 'safetyClass' })
  }

  const inputs = normalizeInputs(raw.inputs, issues)

  const autopilot = normalizeAutopilot(raw.autopilot, issues)

  const estimatedMinutes = Array.isArray(raw.estimatedMinutes)
    ? raw.estimatedMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : []
  if (estimatedMinutes.length !== 2 || estimatedMinutes[0] > estimatedMinutes[1]) {
    issues.push({ code: 'capability_invalid', message: 'estimatedMinutes must be [min, max].', field: 'estimatedMinutes' })
  }

  const budget = normalizeBudget(raw.budget, issues)

  const manifest = {
    id,
    version,
    title,
    description,
    whenToUse,
    persona,
    skills,
    tools,
    produces: normalizedProduces,
    inputs,
    safetyClass,
    autopilot,
    budget,
    estimatedMinutes,
    category: String(raw.category ?? '').trim(),
    dataSources: toStringArray(raw.dataSources),
    starterPrompts: toStringArray(raw.starterPrompts),
  }
  return { ok: issues.length === 0, manifest, issues }
}

/** @param {unknown} value @returns {string[]} */
function toStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

/**
 * @param {unknown} value
 * @param {ManifestIssue[]} issues
 * @returns {{ required: string[], optional: string[] }}
 */
function normalizeInputs(value, issues) {
  if (value == null) return { required: [], optional: [] }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ code: 'capability_invalid', message: 'inputs must be a mapping with required[] and optional[].', field: 'inputs' })
    return { required: [], optional: [] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  return { required: toStringArray(raw.required), optional: toStringArray(raw.optional) }
}

/**
 * `taskTypes` empty means "not eligible for autopilot" — the field replaced a
 * boolean, which §14 rule 16 bans.
 * @param {unknown} value
 * @param {ManifestIssue[]} issues
 * @returns {{ taskTypes: string[], costClass: string, unattendedInputs: string[] }}
 */
function normalizeAutopilot(value, issues) {
  if (value == null) return { taskTypes: [], costClass: 'medium', unattendedInputs: [] }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ code: 'capability_invalid', message: 'autopilot must be a mapping.', field: 'autopilot' })
    return { taskTypes: [], costClass: 'medium', unattendedInputs: [] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const taskTypes = toStringArray(raw.taskTypes)
  for (const type of taskTypes) {
    if (!AUTOPILOT_TASK_TYPES.includes(/** @type {any} */ (type))) {
      issues.push({ code: 'capability_invalid', message: `unknown autopilot task type "${type}".`, field: 'autopilot' })
    }
  }
  const costClass = String(raw.costClass ?? 'medium')
  if (!COST_CLASSES.includes(/** @type {any} */ (costClass))) {
    issues.push({ code: 'capability_invalid', message: `unknown costClass "${costClass}".`, field: 'autopilot' })
  }
  return { taskTypes, costClass, unattendedInputs: toStringArray(raw.unattendedInputs) }
}

/**
 * @param {unknown} value
 * @param {ManifestIssue[]} issues
 * @returns {{ maxSteps: number, maxTokens: number, maxChildren: number }}
 */
function normalizeBudget(value, issues) {
  const fallback = { maxSteps: 120, maxTokens: 4_000_000, maxChildren: 8 }
  if (value == null) return fallback
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ code: 'capability_invalid', message: 'budget must be a mapping.', field: 'budget' })
    return fallback
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  /** @param {unknown} input @param {number} initial @param {string} field @returns {number} */
  const positive = (input, initial, field) => {
    if (input == null) return initial
    const number = Number(input)
    if (!Number.isSafeInteger(number) || number <= 0) {
      issues.push({ code: 'capability_invalid', message: `budget.${field} must be a positive integer.`, field: 'budget' })
      return initial
    }
    return number
  }
  return {
    maxSteps: positive(raw.maxSteps, fallback.maxSteps, 'maxSteps'),
    maxTokens: positive(raw.maxTokens, fallback.maxTokens, 'maxTokens'),
    maxChildren: positive(raw.maxChildren, fallback.maxChildren, 'maxChildren'),
  }
}

/**
 * The contract kind a delegation should use. Derived, never passed by the
 * caller when it can be computed (§14 rule 16).
 * @param {{ produces: readonly { contractKind: string }[] }} manifest
 * @param {string} [declared]
 * @returns {{ ok: true, contractKind: string } | { ok: false, code: string, message: string }}
 */
export function resolveContractKind(manifest, declared) {
  const kinds = manifest.produces.map((item) => item.contractKind)
  if (declared) {
    if (!kinds.includes(declared)) {
      return { ok: false, code: 'contract_kind_unknown', message: `capability does not produce "${declared}".` }
    }
    return { ok: true, contractKind: declared }
  }
  if (kinds.length === 1) return { ok: true, contractKind: kinds[0] }
  return { ok: false, code: 'contract_kind_ambiguous', message: `capability produces ${kinds.length} kinds; the plan must name one.` }
}

/**
 * The full tool allow-list for a delegated child: what the manifest asks for
 * plus the tools every child needs to be able to deliver at all (G3).
 * @param {{ tools: readonly string[] }} manifest
 * @param {{ allowBash?: boolean }} [options]
 * @returns {string[]}
 */
export function delegationToolFilter(manifest, options = {}) {
  const set = new Set([...DELEGATION_BASE_TOOLS, ...manifest.tools])
  if (options.allowBash) set.add('bash')
  return [...set].sort()
}

/** The one-line catalogue the orchestrator sees (§9.6 — the edge of extrapolation).
 *  @param {{ id: string, description: string, whenToUse: string, produces: readonly { contractKind: string }[] }} manifest
 *  @returns {string} */
export function capabilityCatalogueLine(manifest) {
  const kinds = manifest.produces.map((item) => item.contractKind).join(' / ')
  return `${manifest.id} — ${manifest.description} 何时用：${manifest.whenToUse} 产出：${kinds}`
}
