/** Test-only refusal hook: no call may reach a provider during the status proof. */
import { appendFile } from 'node:fs/promises'
export const name = 'matching-no-model-proof'
export const inject = ['llm']
export function apply(ctx) {
  ctx.on('llm/stream', async function* () {
    yield* []
    await appendFile(process.env.MATCHING_PROOF_NO_MODEL_LOG, 'unexpected model request\n')
    throw new Error('A status probe may not request a model')
  })
}
