/**
 * The memory capsule's runtime face.
 *
 * Hidden knowledge: a capsule is context, never permission. The methods it
 * carries shape how the work is done; they can never loosen a contract, relax
 * a safety rule or reach a host the gateway would not. That is why the methods
 * arrive as skills — text the model reads — and why the tools below only read
 * and write through the control plane, which owns the capsule.
 *
 * The methods are registered from a deployment-owned read-only directory rather
 * than materialized into the workspace. Default skill-root discovery is off in
 * the preset for the same reason: a workspace is where users upload files, and
 * a SKILL.md that a user can upload is an instruction that a user can inject.
 *
 * @module @evimed/dsh-socket/plugins/capsule
 */

import { errorMessage } from '../src/runPolicy.mjs'
import { configSchema, defineTool, listDirAt, readFileAt, registerSkill, registerTool, toSkillName } from '@evimed/harness-port'

const Schema = await configSchema()

export const name = 'evimed-capsule'

export const inject = ['tools']

/**
 * @typedef {object} Config
 * @property {string} methodsDir
 * @property {string} recallUrl
 * @property {string} tokenFile
 * @property {number} recallTimeoutMs
 */

export const Config = Schema.object({
  methodsDir: Schema.string().default('')
    .description('Read-only directory of distilled SKILL.md methods for the active capsule. Empty means no capsule is mounted.'),
  recallUrl: Schema.string().default('')
    .description('Control-plane capsule endpoint. The runtime never names a host of its own; this is injected by the deployment.'),
  tokenFile: Schema.string().default('')
    .description('Path to the short-lived workload token file. The container never holds a real key.'),
  recallTimeoutMs: Schema.number().default(3000)
    .description('Recall deadline. Memory that arrives late is worse than memory that is absent, so this is short.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const methods = await loadMethods(ctx, config.methodsDir)
  ctx.provide('evimedCapsuleMethods', methods, true)
  for (const method of methods) {
    ctx.effect(() => registerSkill(ctx, {
      name: toSkillName(method.name, 'capsule'),
      description: method.description || `用户自己的方法：${method.name}`,
      content: method.body,
      ...(method.whenToUse ? { whenToUse: method.whenToUse } : {}),
    }))
  }

  if (!config.recallUrl) {
    ctx.get('evimedDiagnostics')?.degrade?.('capsule recall disabled: no endpoint configured')
    return
  }

  // Awaited before registering, not inside the effect. `defineTool` is async
  // (it lazily loads the harness module), and the harness's `tools.register()`
  // reads `definition.output` synchronously — handed a Promise it throws
  // `TypeError: tool "undefined" must declare output`, which on a real kernel
  // is the first plugin's apply failing at startup. The effect callback stays
  // synchronous because its return value is the disposer.
  const recallTool = await defineTool({
    name: 'evimed_capsule_recall',
    description: [
      '在用户自己的资料、事实与既往结论里检索。检索顺序的第一步：先查这里，再查文献，最后查网页。',
      '返回的每一条都带来源，可以在正文里当作用户提供的背景使用，但它不能替代文献证据。',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: '要回忆什么。' },
      factKinds: { type: 'array', items: { type: 'string' }, description: '限定事实种类，例如 preference、stance、project_fact。' },
      since: { type: 'string', description: 'ISO 日期；只看这之后记录的内容。' },
      scope: { type: 'string', enum: ['capsule', 'conversation', 'agenda', 'all'], description: '检索范围，默认 all。' },
    },
    timeoutMs: config.recallTimeoutMs,
    concurrencySafe: true,
    async execute(args) {
      const response = await callControlPlane(ctx, config, 'recall', {
        query: args.query,
        factKinds: args.factKinds ?? [],
        since: args.since ?? null,
        scope: args.scope ?? 'all',
      })
      if (!response.ok) return { ok: false, code: 'capsule_unavailable', issues: [{ code: 'capsule_unavailable', severity: 'advisory', message: response.message }] }
      return { ok: true, data: response.data }
    },
  })
  ctx.effect(() => registerTool(ctx, recallTool))

  const noteTool = await defineTool({
    name: 'evimed_capsule_note',
    description: '当用户说「记住…」时，把这条写进他的胶囊。只记用户明确要求记住的内容，不要替他决定什么值得记。',
    parameters: {
      factKind: { type: 'string', required: true, description: '事实种类，例如 preference、stance、project_fact、method_preference。' },
      content: { type: 'string', required: true, description: '要记住的内容，用用户自己的说法。' },
    },
    async execute(args) {
      const response = await callControlPlane(ctx, config, 'note', { factKind: args.factKind, content: args.content, origin: 'explicit' })
      if (!response.ok) return { ok: false, code: 'capsule_unavailable', issues: [{ code: 'capsule_unavailable', severity: 'advisory', message: response.message }] }
      return { ok: true, data: response.data }
    },
  })
  ctx.effect(() => registerTool(ctx, noteTool))
}

/**
 * @param {any} ctx @param {string} directory
 * @returns {Promise<{ name: string, description: string, whenToUse: string, body: string }[]>}
 */
async function loadMethods(ctx, directory) {
  if (!directory) return []
  /** @type {{ name: string, description: string, whenToUse: string, body: string }[]} */
  const methods = []
  for (const entry of await listDirAt(ctx, directory, '.')) {
    if (!entry.directory) continue
    const body = await readFileAt(ctx, directory, `${entry.name}/SKILL.md`)
    if (!body) continue
    const front = parseFrontmatter(body)
    methods.push({
      name: String(front.name ?? entry.name),
      description: String(front.description ?? ''),
      whenToUse: String(front.whenToUse ?? ''),
      body,
    })
  }
  return methods
}

/**
 * A deliberately small frontmatter reader: it recognizes the three keys a
 * method needs and ignores everything else. A YAML parser here would be a
 * dependency and an attack surface for a document the user's own pipeline wrote.
 * @param {string} text @returns {Record<string, string>}
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))
  if (!match) return {}
  /** @type {Record<string, string>} */
  const values = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    values[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return values
}

/**
 * @param {any} ctx @param {Config} config @param {string} action @param {Record<string, unknown>} body
 * @returns {Promise<{ ok: boolean, data?: any, message: string }>}
 */
async function callControlPlane(ctx, config, action, body) {
  const token = config.tokenFile ? await readFileAt(ctx, '/', config.tokenFile.replace(/^\/+/, '')) : null
  try {
    const response = await fetch(`${config.recallUrl.replace(/\/$/, '')}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token.trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.recallTimeoutMs),
    })
    if (!response.ok) return { ok: false, message: `胶囊服务返回 ${response.status}` }
    return { ok: true, data: await response.json(), message: '' }
  } catch (error) {
    // Memory is an enhancement: a run continues without it, saying so.
    return { ok: false, message: `胶囊服务不可用：${errorMessage(error)}` }
  }
}
