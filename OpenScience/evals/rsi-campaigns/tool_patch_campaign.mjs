/**
 * The tool-patch consumer (2026-11-02): the harness-patch campaign (harness_campaign.mjs) for a candidate that holds code as well as
 * text — a tool, a connector, a change of the runtime image beside the guidance and skills that tell the model about it. Everything a
 * campaign does is the harness consumer's (the A/A control, the sealed confirmation, the scorers, the settled lane costs, the
 * directional rule); what this surface adds is only who it is:
 *
 *  - its own consumer identity, which binds the files this surface is made of, so a tool-patch registration pins a consumer that is
 *    not the harness-patch one and the two never certify each other's candidates;
 *  - NOT its own error budget (2026-11-03): the runner keys a quarter's ledger by the consumer, and a tool patch and a harness patch change
 *    the same one, the runtime image (`dsh-harness`), so they draw on one quarter's 0.05 between them;
 *  - the same assembly (harness_assemble.mjs): the improvers come from the round's improvement record, the judge from the registration;
 *  - a candidate arm that carries its code (`harness.code`, normalised and digested by harness_campaign.mjs): a registration that
 *    names this surface refuses an arm without code, and a harness-patch registration refuses an arm with it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { harnessScorer } from './harness_scorers.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

/** The consumer as the evaluator pins it for this surface. @param {any} [registration] */
export async function toolPatchCampaignConsumerIdentity(registration) {
  const scorer = harnessScorer(registration);
  if (!scorer) throw new Error('campaign_scorer_not_qualified');
  const components = ['skill_campaign.mjs', 'skill_scorers.mjs', 'harness_scorers.mjs', 'harness_campaign.mjs', 'directional.mjs', 'tool_patch_campaign.mjs']
    .map((name) => ({ path: `evals/rsi-campaigns/${name}`, sha256: sha(readFileSync(new URL(`./${name}`, import.meta.url))) }));
  return { revision: 'tool-patch-arms-v1', scorer: scorer.id, components, implementationSha256: sha(JSON.stringify({ scorer: scorer.id, components })) };
}
