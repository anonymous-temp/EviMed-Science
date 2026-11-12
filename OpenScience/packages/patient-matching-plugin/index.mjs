import { readFile } from 'node:fs/promises'
import { configSchema, defineTool, registerTool, registerSkill, registerPatientMatchingStatus, reservedChildComposition, installChildComposition, SEAMS } from '@evimed/harness-port'
import { TOOL_MANIFEST, nativeParameterFields } from './src/manifest.mjs'
import { CHILD_PERSONA, createMatchingHandler } from './src/handler.mjs'
import { createHttpHostTransport } from './src/transport.mjs'
export { createMatchingHandler } from './src/handler.mjs'
export { createHttpHostTransport, hostFromTransport } from './src/transport.mjs'
export { TOOL_MANIFEST, CHILD_TOOLS, validateArguments } from './src/manifest.mjs'
export const name = 'evimed-patient-matching'
export const inject = ['tools', 'subagents', 'agents', 'skills']
const Schema = await configSchema()
export const Config = Schema.object({ enabled: Schema.boolean().default(false), endpoint: Schema.string().default(''), tokenFile: Schema.string().default('') })
export async function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  // A host call may run as long as its tool (120 s): discovery on the production host (registry search and rerank) passed the
  // transport's 30 s default three times in the first production conversation (2026-11-11) and was retried by the model.
  const transport = createHttpHostTransport({ endpoint: config.endpoint, tokenFile: config.tokenFile, timeoutMs: 110000 })
  const handle = createMatchingHandler({ transport, ctx })
  const tools = await Promise.all(TOOL_MANIFEST.map(entry => defineTool({ name: entry.name, description: entry.description, parameters: nativeParameterFields(entry.parameters), timeoutMs: entry.name === 'match_assess' ? 600000 : 120000, concurrencySafe: false, async execute(args, call) {
    const response = await handle(entry.name, args, call)
    return { ok: !['failed', 'unsupported', 'cancelled'].includes(response.status), data: response }
  } })))
  for (const tool of tools) ctx.effect(() => registerTool(ctx, tool))
  const content = await readFile(new URL('./skills/patient-matching/SKILL.md', import.meta.url), 'utf8')
  ctx.effect(() => registerSkill(ctx, { name: 'patient-matching', description: 'Source-backed patient-to-trial or protocol-to-patient matching through scoped native tools.', whenToUse: 'A user asks to match actual patient information against clinical trial criteria, discover trials or correct an existing matching result.', content }))
  await registerPatientMatchingStatus(ctx, { tools: TOOL_MANIFEST.map(tool => tool.name), cancel: handle.cancel })
  // Standalone profiles do not carry the EviMed socket's composition listener. Touch only our reserved
  // child; unrelated native children keep their existing composition. A shared socket may consume it first.
  ctx.effect(() => ctx.on(SEAMS.events.sessionStart, ({ agent }) => {
    if (reservedChildComposition(String(agent?.session?.id ?? ''))?.persona === CHILD_PERSONA) installChildComposition(agent, { deny: [] })
  }))
}
