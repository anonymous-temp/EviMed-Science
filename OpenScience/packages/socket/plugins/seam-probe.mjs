/**
 * Startup self-check.
 *
 * Hidden knowledge: "is the DSH in this deployment still the one we were built
 * against". DSH renames and repackages freely before its first tagged release,
 * and the dangerous half of that is not the half that errors — a renamed event
 * still registers, the listener simply never fires, and a gate that never fires
 * is a gate that passes everything. So this plugin does not check that a name
 * exists; it drives a real tool through the pipeline and asserts both the
 * policy seam and the observation seam actually fired.
 *
 * Failure is graded. A gate-level seam missing means the deployment cannot
 * enforce what it promises, so the process must not start. An enhancement
 * missing means one capability is off, which a run survives with a named
 * counter and a visible notice.
 *
 * @module @evimed/dsh-socket/plugins/seam-probe
 */

import { SEAMS, configSchema, probeSeams } from '@evimed/harness-port'

const Schema = await configSchema()

export const name = 'evimed-seam-probe'

export const inject = [...SEAMS.services.required]

/**
 * @typedef {object} Config
 * @property {'full'|'partial'} requiredEnforcement
 * @property {string} dshVersion
 */

export const Config = Schema.object({
  // A hosted container must have a working Landlock backend or `bash` fails
  // closed while the runtime still looks healthy. A laptop on macOS gets
  // Seatbelt, which reports `partial`, and refusing to start there would make
  // the local profile unusable for the sake of a guarantee it cannot give.
  requiredEnforcement: Schema.union(['full', 'partial']).default('full')
    .description('Minimum sandbox enforcement. Hosted deployments set full; a local profile may set partial.'),
  // Written by the image build. Empty skips the check, which is what a
  // development checkout wants.
  dshVersion: Schema.string().default('')
    .description('The DSH version the image installed. A deployment pinning a different one must say so here.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const result = await probeSeams(ctx, {
    ...(config.dshVersion ? { dshVersion: config.dshVersion } : {}),
    requiredEnforcement: config.requiredEnforcement,
  })
  if (result.fatal.length) {
    throw new Error(`evimed: startup self-check failed — ${result.fatal.join('; ')}`)
  }
  const diagnostics = ctx.get('evimedDiagnostics')
  for (const line of result.degraded) diagnostics?.degrade?.(line)
  ctx.effect?.(() => () => {})
}
