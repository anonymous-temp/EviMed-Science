/**
 * The orchestration guidance section.
 *
 * Hidden knowledge: what the model is told about how to work, and where the
 * edge of its abilities is. There is no router and no mode; this section plus
 * `evimed_plan` is the entire dispatch mechanism, and the capability catalogue
 * inside it is the honest boundary — a capability listed can be composed, one
 * that is not gets "we do not do that" instead of an improvisation of it.
 *
 * The catalogue is generated from the capability manifests the deployment
 * mounted, never hand-written: a catalogue that drifts from the manifests
 * promises work nobody can do.
 *
 * @module @evimed/dsh-socket/plugins/guidance
 */

import { errorMessage } from '../src/runPolicy.mjs'
import { validateCapabilityManifest } from '@evimed/domain'
import { configSchema, listDirAt, readFileAt, registerSection } from '@evimed/harness-port'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER, buildGuidanceText } from '../src/guidanceText.mjs'

const Schema = await configSchema()

export const name = 'evimed-guidance'

export const inject = ['systemPrompt']

/**
 * @typedef {object} Config
 * @property {string} capabilitiesDir
 * @property {boolean} askUserEnabled
 * @property {boolean} capsuleActive
 * @property {boolean} reviewEnabled
 */

export const Config = Schema.object({
  // A deployment-owned read-only directory. It is not the workspace: a manifest
  // a user could upload would be a capability a user could invent.
  capabilitiesDir: Schema.string().default('')
    .description('Read-only directory holding capability.yaml manifests. The hosted image and the local installer set different paths.'),
  askUserEnabled: Schema.boolean().default(false)
    .description('Whether this deployment lets a run stop and ask. Hosted runs are unattended, local ones are not.'),
  capsuleActive: Schema.boolean().default(false)
    .description('Whether a memory capsule is mounted for this session; changes the retrieval order the guidance states.'),
  reviewEnabled: Schema.boolean().default(false)
    .description('Whether the cross-deliverable reviewer is composed in this deployment.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const capabilities = await loadCapabilities(ctx, config.capabilitiesDir)
  const text = buildGuidanceText(capabilities, {
    askUserEnabled: config.askUserEnabled,
    capsuleActive: config.capsuleActive,
    reviewEnabled: config.reviewEnabled,
  })
  ctx.provide('evimedCapabilities', capabilities, true)
  ctx.effect(() => registerSection(ctx, { name: GUIDANCE_SECTION_NAME, order: GUIDANCE_SECTION_ORDER, text }))
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
