/**
 * The guidance section every conversation reads.
 *
 * Hidden knowledge: what the model is told about how to work, whatever the
 * work is. There is no router and no mode: a general assistant answers, writes
 * files and looks things up with the kernel's own tools, and this section says
 * only what every such task needs. The capability catalogue inside it is an
 * index of the professional workflows a plan may name — a workflow listed can
 * be planned, and a task that is not one of them is simply done, not declined.
 *
 * The index is generated from the capability manifests the deployment mounted,
 * never hand-written: an index that drifts from the manifests promises a
 * workflow nobody can run.
 *
 * @module @evimed/dsh-socket/plugins/guidance
 */

import { errorMessage } from '../src/runPolicy.mjs'
import { validateCapabilityManifest } from '@evimed/domain'
import {
  configSchema,
  isSubagentSession,
  listDirAt,
  onSessionStart,
  readFileAt,
  registerAgentSection,
  registerSection,
} from '@evimed/harness-port'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER, buildChildGuidanceText, buildGuidanceText } from '../src/guidanceText.mjs'

const Schema = await configSchema()

export const name = 'evimed-guidance'

export const inject = ['systemPrompt']

/**
 * @typedef {object} Config
 * @property {boolean} [enabled]
 * @property {string} capabilitiesDir
 * @property {boolean} askUserEnabled
 * @property {boolean} capsuleActive
 * @property {boolean} reviewEnabled
 * @property {string} [disabledToolsFile]
 * @property {boolean} [runPolicyEnabled]
 * @property {boolean} [capsuleEnabled]
 * @property {boolean} [capsuleMemoryEnabled]
 * @property {boolean} [openVikingMemory]
 */

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Off registers nothing: no prompt section, no capability catalogue, no hook (EVIMED_GUIDANCE_ENABLED=0).'),
  // A deployment-owned read-only directory. It is not the workspace: a manifest
  // a user could upload would be a capability a user could invent.
  capabilitiesDir: Schema.string().default('')
    .description('Read-only directory holding capability.yaml manifests. The hosted image and the local installer set different paths.'),
  askUserEnabled: Schema.boolean().default(false)
    .description('Whether the ask-user tool is mounted in this runtime (EVIMED_ASK_USER). On, the guidance says when a question is worth asking; off, it says to state the assumption and go on.'),
  capsuleActive: Schema.boolean().default(false)
    .description('Whether a memory capsule is mounted for this session; changes the retrieval order the guidance states.'),
  reviewEnabled: Schema.boolean().default(false)
    .description('Whether the cross-deliverable reviewer is composed in this deployment.'),
  disabledToolsFile: Schema.string().default('')
    .description('File holding the base tool names this runtime does not offer (the MCP server\'s EVIMED_DISABLED_TOOLS); a capability built on a switched-off module tool is not offered. Empty offers every capability.'),
  // The switches of the rows whose tools this text names. Each switch has to
  // leave a coherent session: the guidance names no plan, delegation or
  // submission tool when run-policy is off, and no capsule tool when the
  // capsule row is.
  runPolicyEnabled: Schema.boolean().default(true)
    .description('Whether the run-policy row (plan, delegation, submission tools) is on; off, the guidance names none of its tools (EVIMED_RUN_POLICY_ENABLED).'),
  capsuleEnabled: Schema.boolean().default(true)
    .description('Whether the capsule row (evimed_capsule_recall) is on; off, the guidance does not name its tools (EVIMED_CAPSULE_ENABLED).'),
  capsuleMemoryEnabled: Schema.boolean().default(true)
    .description('Whether the capsule row\'s recall and note tools are mounted (EVIMED_CAPSULE_MEMORY_ENABLED, and not an account on the native memory engine); off, the guidance does not name them.'),
  openVikingMemory: Schema.boolean().default(false)
    .description('Whether this account\'s memory is kept by the official OpenViking plugin (EVIMED_MEMORY_GATEWAY_URL is set); the guidance then says how to read what the plugin injects and returns.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  if (config.enabled === false) return
  const capabilities = await capabilityCatalogue(ctx, config.capabilitiesDir, config.disabledToolsFile ?? '')
  const text = buildGuidanceText(capabilities, {
    askUserEnabled: config.askUserEnabled,
    capsuleActive: config.capsuleActive,
    reviewEnabled: config.reviewEnabled,
    runPolicyEnabled: config.runPolicyEnabled !== false,
    capsuleToolEnabled: config.capsuleEnabled !== false && config.capsuleMemoryEnabled !== false,
    openVikingMemory: config.openVikingMemory === true,
  })
  ctx.provide('evimedCapabilities', capabilities, true)
  ctx.effect(() => registerSection(ctx, { name: GUIDANCE_SECTION_NAME, order: GUIDANCE_SECTION_ORDER, text }))
  // The kernel's produced-files paragraph (`ui:deliverable-file-references`)
  // stays. It was withdrawn here from 2026-09-18, when `present` was not
  // mounted and the page's preview pane was disabled, so the paragraph asked
  // for links and cards that could not render. Both are back (the preview
  // since 2026-09-22, `present` with this change), and the paragraph is the
  // kernel's own account of when a file card helps and how a file is linked.

  // A delegated child is not the orchestrator. Its section is replaced in the
  // child's own scope before its first request is assembled, by the part that
  // holds for any agent doing the work. Nothing of the root's prompt changes.
  //
  // There is no answer persona to withhold from it any more. Until 2026-10-12
  // this row also injected `open-domain-answer/SKILL.md` — the evidence-based
  // answer method — into every root session as a second always-on section
  // (8,271 characters), so that the answer line's `skillsLoaded` check was
  // true by construction; a conversation about an e-mail read a method that
  // opens 「an evidence-based-medicine specialist」. The method is a skill now:
  // the model loads it when the question is medical or asks what the
  // literature shows, and the control plane holds a reply to the method's
  // citation floor only when the run actually loaded it.
  const childText = buildChildGuidanceText({ capsuleActive: config.capsuleActive, capsuleToolEnabled: config.capsuleEnabled !== false && config.capsuleMemoryEnabled !== false })
  ctx.effect(() => onSessionStart(ctx, (agent) => {
    if (!isSubagentSession(agent) || !agent?.ctx) return
    try {
      registerAgentSection(agent, { name: GUIDANCE_SECTION_NAME, order: GUIDANCE_SECTION_ORDER, text: childText })
    } catch (error) {
      ctx.get('evimedDiagnostics')?.degrade?.(`child guidance not installed: ${errorMessage(error)}`)
    }
  }))
}

/**
 * Reads and validates the manifests. A manifest that does not validate is
 * dropped with a named diagnostic rather than half-loaded: a capability the
 * catalogue advertises and the delegate tool cannot assemble is worse than one
 * that is simply absent.
 *
 * The manifests are read as JSON, not YAML. The build step that copies them
 * into the image already parses and validates the YAML, so parsing it a second
 * time here would put a YAML parser (and its version) inside the run container
 * for no gain — and it would let a manifest that failed the build still be
 * loaded at runtime.
 *
 * @param {any} ctx
 * @param {string} directory
 * @returns {Promise<Record<string, any>[]>}
 */
export async function loadCapabilities(ctx, directory) {
  // An empty catalogue disables delegation entirely, so it says so.
  //
  // A single unreadable manifest already degrades loudly below. The directory
  // itself was the quiet case: unset, absent or empty, this returned `[]`, and
  // every later delegation failed with "not in the catalogue" — a message about
  // the request rather than about the deployment. The same shape cost a whole
  // run when `EVIMED_PRESET_SKILLS_DIR` went unset and the skill roots resolved
  // to `undefined/…`: nothing loaded, nothing complained, and the model simply
  // did not know what it was supposed to do.
  if (!directory) {
    ctx.get('evimedDiagnostics')?.degrade?.(
      'capability catalogue disabled: no capabilities directory is configured (EVIMED_CAPABILITIES_DIR)',
    )
    return []
  }
  /** @type {Record<string, any>[]} */
  const manifests = []
  const entries = await listDirAt(ctx, directory, '.')
  if (!entries.length) {
    ctx.get('evimedDiagnostics')?.degrade?.(
      `capability catalogue is empty: ${directory} holds no manifests, so every delegation will be refused`,
    )
    return []
  }
  for (const entry of entries.filter((item) => item.name.endsWith('.json')).sort((left, right) => left.name.localeCompare(right.name))) {
    const text = await readFileAt(ctx, directory, entry.name)
    if (!text) {
      ctx.get('evimedDiagnostics')?.degrade?.(`capability manifest unreadable: ${entry.name}`)
      continue
    }
    /** @type {unknown} */
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      ctx.get('evimedDiagnostics')?.degrade?.(`capability manifest is not JSON: ${entry.name} — ${errorMessage(error)}`)
      continue
    }
    const result = validateCapabilityManifest(raw)
    if (result.ok && result.manifest) {
      manifests.push(result.manifest)
      continue
    }
    const id = raw && typeof raw === 'object' ? String(/** @type {Record<string, unknown>} */ (raw).id ?? entry.name) : entry.name
    ctx.get('evimedDiagnostics')?.degrade?.(`capability manifest rejected: ${id} — ${result.issues.map((issue) => issue.message).join('; ')}`)
  }
  return manifests
}

/**
 * Tools a capability cannot work without because they ARE its module: the
 * 「循证 GEO」 capabilities read and write the project's GEO record through
 * `geo_read`/`geo_write`, and the five 「虚拟临床研究」 capabilities read and write
 * the study through `vcr_read`/`vcr_write`; and the control plane switches them off (`EVIMED_DISABLED_TOOLS`)
 * wherever the module is not open to the account. A capability declaring one
 * of them is not offered there, so plain chat with the module off is what it
 * was before the module existed (build spec 2026-09-25 §0.1).
 */
export const MODULE_TOOLS = Object.freeze(['geo_read', 'geo_write', 'vcr_read', 'vcr_write'])

/**
 * The file the control plane wrote before the kernel started. Absent or
 * unreadable reads as nothing switched off: every capability stays offered,
 * which is what a runtime without the module ever saw.
 * @param {any} ctx @param {string} file
 * @returns {Promise<string>}
 */
export async function readDisabledTools(ctx, file) {
  if (!file) return ''
  const slash = file.lastIndexOf('/')
  if (slash <= 0) return ''
  try {
    return String(await readFileAt(ctx, file.slice(0, slash), file.slice(slash + 1)) ?? '')
  } catch {
    return ''
  }
}

/**
 * The capabilities this runtime offers: the mounted manifests, less those
 * built on a switched-off module tool. What the guidance lists and the
 * run-policy validates plans against — the run-policy reads it itself when
 * the guidance row is switched off, so a plan still has a catalogue.
 * @param {any} ctx @param {string} capabilitiesDir @param {string} disabledToolsFile
 * @returns {Promise<Record<string, any>[]>}
 */
export async function capabilityCatalogue(ctx, capabilitiesDir, disabledToolsFile) {
  return offeredCapabilities(await loadCapabilities(ctx, capabilitiesDir), disabledTools(await readDisabledTools(ctx, disabledToolsFile)))
}

/** @param {string | undefined} raw @returns {Set<string>} */
export function disabledTools(raw) {
  return new Set(String(raw ?? '').split(',').map((tool) => tool.trim()).filter(Boolean))
}

/**
 * @param {Record<string, any>[]} manifests
 * @param {Set<string>} disabled base tool names switched off in this runtime
 * @returns {Record<string, any>[]}
 */
export function offeredCapabilities(manifests, disabled) {
  const off = MODULE_TOOLS.filter((tool) => disabled.has(tool))
  if (!off.length) return manifests
  return manifests.filter((manifest) => !(manifest.tools ?? []).some((/** @type {unknown} */ tool) =>
    off.includes(String(tool).replace(/^mcp__evimed__/, ''))))
}
