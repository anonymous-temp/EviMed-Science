/**
 * `@evimed/dsh-socket` — the plug.
 *
 * Hidden knowledge: everything EviMed adds to a DeepSeek Harness, in the shape
 * DSH wants it. Two host-scope plugins (the startup self-check and the run
 * mirror), five agent-scope plugins (guidance, run policy, evidence, capsule,
 * review), one composition, and the patch rows that connect them. The bundle
 * carries no paths and no addresses — those come from the profile patch the
 * deployment generates, which is what lets the same tarball plug into the
 * hosted container and into a laptop.
 *
 * This entry point exists for tooling (the consistency suite, the packaging
 * check). DSH itself loads the plugins by their subpath specifiers, listed in
 * `cordis.patch.yml` and `presets/evimed-universal/agent.cordis.yml`.
 *
 * @module @evimed/dsh-socket
 */

export const BUNDLE_NAME = '@evimed/dsh-socket'

/** The plugin row ids this bundle owns. The `--dump-config` snapshot test walks it. */
export const HOST_PLUGIN_IDS = Object.freeze(['evimed-seam-probe', 'evimed-evidence-store'])
export const AGENT_PLUGIN_IDS = Object.freeze(['evimed-guidance', 'evimed-run-policy', 'evimed-evidence', 'evimed-capsule', 'evimed-screening', 'evimed-review'])

/** The single composition. There is no second one, and adding one is a design change. */
export const PRESET_NAME = 'evimed-universal'

/** Module specifiers, so the packaging test can assert every row resolves. */
export const PLUGIN_SPECIFIERS = Object.freeze({
  'evimed-seam-probe': './plugins/seam-probe.mjs',
  'evimed-evidence-store': './plugins/evidence-store.mjs',
  'evimed-guidance': './plugins/guidance.mjs',
  'evimed-run-policy': './plugins/run-policy.mjs',
  'evimed-evidence': './plugins/evidence.mjs',
  'evimed-capsule': './plugins/capsule.mjs',
  'evimed-screening': './plugins/screening.mjs',
  'evimed-review': './plugins/review.mjs',
})

export { buildGuidanceText, GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER } from './src/guidanceText.mjs'
export { RUN_DOMAIN_SPEC, RUN_STATE_FORMAT_VERSION, projectRunState, staleEvidence } from './src/runMirror.mjs'
export {
  evidenceFromOutcome,
  mergeEvidence,
  sourceProbe,
} from './src/evidenceIngest.mjs'
export { chunk, renderScreeningLedger, screeningPrompt, SCREEN_VERDICT_SCHEMA } from './src/screening.mjs'
export {
  accumulateBudget,
  buildDelegation,
  completionCheck,
  delegatableItems,
  evidenceSourceErrorCode,
  gateDeliverable,
  guardedBashTarget,
  indexPlan,
  rejectionEnvelope,
  renderDeliverySummary,
  settleDelegation,
  sourceArtifactPaths,
  stepPolicy,
  toolPolicy,
} from './src/runPolicy.mjs'
