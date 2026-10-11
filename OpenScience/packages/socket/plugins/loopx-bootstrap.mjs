/** Bootstrap only; goal state, GoalBar and continuation are the upstream plugin's. */
import { configSchema, registerHostedLoopx } from '@evimed/harness-port'

const Schema = await configSchema()
export const name = 'evimed-loopx-bootstrap'
export const inject = ['commands', 'systemPrompt']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  root: Schema.string().default('/opt/evimed/loopx'),
  cli: Schema.string().default('/opt/evimed/venv/bin/loopx'),
})
/** @param {any} ctx @param {{enabled:boolean, root:string, cli:string}} config */
export async function apply(ctx, config) {
  await registerHostedLoopx(ctx, config)
}
