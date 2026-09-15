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

/** The persona the answer line is graded against. */
const ANSWER_PERSONA_SKILL = 'open-domain-answer'
/** Sits just after the orchestration guidance, inside DSH's guidance band. */
const ANSWER_PERSONA_SECTION_NAME = 'evimed:answer-persona'
const ANSWER_PERSONA_SECTION_ORDER = GUIDANCE_SECTION_ORDER + 1
/**
 * A skill body far larger than this is a packaging mistake, not a persona.
 *
 * Counted in characters rather than bytes: this plugin's lint environment has
 * no `Buffer`, and the number is a sanity ceiling, not an accounting of the
 * wire. `open-domain-answer` is a few thousand characters.
 */
const ANSWER_PERSONA_MAX_CHARS = 32_000

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
  // Where `open-domain-answer/SKILL.md` lives in this image.
  //
  // Principle 7: priors live in context, not control flow. The answer line's
  // contract requires this persona to have been loaded, and the model was left
  // to fetch it with the `skill` tool — which it skips on a fast question. On
  // 2026-09-15 a fourteen-second answer with clean citations was delivered
  // 「待人工复核」 because of it, and the production ledger had already shown
  // 11 of 17 answer-line runs doing the same. The platform is holding the text;
  // handing it over costs one section and removes a whole class of false doubt.
  answerPersonaDir: Schema.string().default('')
    .description('Read-only directory holding the open-domain-answer skill package. Empty leaves the model to load it itself.'),
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

  // Provided whether or not the persona loads, so a reader of the projection
  // can tell "this deployment injects nothing" from "this key is missing".
  const persona = await loadAnswerPersona(ctx, config.answerPersonaDir)
  ctx.provide('evimedInjectedSkills', persona ? [ANSWER_PERSONA_SKILL] : [], true)
  if (persona) {
    ctx.effect(() => registerSection(ctx, {
      name: ANSWER_PERSONA_SECTION_NAME,
      order: ANSWER_PERSONA_SECTION_ORDER,
      text: persona,
    }))
  }
}

/**
 * The answer-line persona, wrapped so the model can see what it is.
 *
 * Returns null — not a throw and not an empty section — when the deployment
 * did not mount it. A missing persona is the state that existed before this
 * function, and the gate's `skillsLoaded` check still covers it: without the
 * injection the run has to load the skill itself, exactly as it did.
 *
 * @param {any} ctx @param {string} directory @returns {Promise<string | null>}
 */
export async function loadAnswerPersona(ctx, directory) {
  if (!directory) return null
  let body = ''
  try {
    body = String(await readFileAt(ctx, directory, 'SKILL.md') ?? '')
  } catch (error) {
    ctx.get('evimedDiagnostics')?.degrade?.(`answer persona unreadable: ${errorMessage(error)}`)
    return null
  }
  if (!body.trim()) {
    ctx.get('evimedDiagnostics')?.degrade?.(`answer persona is empty: ${directory}/SKILL.md`)
    return null
  }
  if (body.length > ANSWER_PERSONA_MAX_CHARS) {
    ctx.get('evimedDiagnostics')?.degrade?.(
      `answer persona too large to inject (${body.length} characters); the model must load it itself`,
    )
    return null
  }
  return [
    `<evimed-skill name="${ANSWER_PERSONA_SKILL}">`,
    '',
    '开放域问答的人设与规范正文如下，已由平台直接注入，无需再用 skill 工具加载。',
    '',
    body.trim(),
    '',
    '</evimed-skill>',
  ].join('\n')
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
