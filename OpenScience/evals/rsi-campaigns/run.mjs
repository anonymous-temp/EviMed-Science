#!/usr/bin/env node
/**
 * The lab's campaign CLI. `run` executes development and the sealed confirmation and stops at `awaiting-evaluation`,
 * writing the evaluator's request and the checkpoint to --out-dir; the evaluator (evaluator.mjs, its own key) signs a
 * receipt; `resume` with --evaluator-profile completes the registered statistics. Every command prints one JSON result.
 *
 *   node run.mjs plan|preflight|run|resume|report --manifest m.json --inputs i.json --config /run/rsi-lab/config.json
 *        [--evaluator-profile /run/rsi-lab/evaluator.json] [--incident-transport /run/rsi-lab/transport.json] [--out-dir dir]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { campaignPlan, runCampaign, labPreflight, productCampaignStore, signedEvaluatorReceipt } from './campaign_runner.mjs';
import { rsiLabConfigurationIssues } from '../../apps/server/src/rsiLabConfiguration.mjs';

const [command] = process.argv.slice(2);
const { values } = parseArgs({ args: process.argv.slice(3), options: { manifest: { type: 'string' }, inputs: { type: 'string' }, config: { type: 'string' },
  'evaluator-profile': { type: 'string' }, 'incident-transport': { type: 'string' }, 'out-dir': { type: 'string' } } });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const ownerMount = (path) => typeof path === 'string' && path.startsWith('/run/rsi-lab/') && !path.split('/').includes('..');
if (!['plan', 'preflight', 'run', 'resume', 'report'].includes(command)) throw new Error('Usage: run.mjs plan|preflight|run|resume|report --manifest m.json --inputs i.json --config c.json');
const manifest = await json(values.manifest);
const emit = async (result) => {
  console.log(JSON.stringify(result, null, 1));
  if (values['out-dir']) {
    await mkdir(values['out-dir'], { recursive: true });
    await writeFile(join(values['out-dir'], `${command}.json`), `${JSON.stringify(result)}\n`);
    if (result?.status === 'awaiting-evaluation') await writeFile(join(values['out-dir'], 'request.json'), `${JSON.stringify(result.request)}\n`);
  }
};
if (command === 'plan') await emit(campaignPlan(manifest));
else {
  const configuration = values.config ? await json(values.config) : {};
  const issues = rsiLabConfigurationIssues(configuration);
  if (issues.length) { await emit({ status: 'not-qualified', reason: issues.includes('campaign_host_unavailable') ? 'campaign_host_unavailable' : issues[0] }); process.exitCode = 2; }
  else {
    // Only the deployment-owned launcher supplies this connection reference. No model environment is forwarded.
    const { ControlPlaneDatabase } = await import('../../apps/server/src/controlPlaneDatabase.mjs');
    const database = new ControlPlaneDatabase({ databaseUrl: process.env.RSI_LAB_DATABASE_URL, databasePoolMax: 4, databaseConnectionTimeoutMs: 5000 });
    const attestLab = async () => {
      const result = await database.query('SELECT current_user AS role,current_database() AS database');
      const metadata = await fetch('http://100.100.100.200/latest/meta-data/instance-id', { signal: AbortSignal.timeout(2000) });
      if (!metadata.ok) throw new Error('campaign_host_unavailable');
      return { ...result.rows[0], hostInstanceId: (await metadata.text()).trim(), hostPurpose: await readFile('/run/rsi-lab/purpose', 'utf8').then((x) => x.trim()) };
    };
    try {
      const store = productCampaignStore(database, configuration.authority.accountId);
      let attestEvaluation;
      if (values['evaluator-profile']) {
        // The trust root (the public key and its digest) is the owner's; the receipt it verifies may live anywhere.
        if (!ownerMount(values['evaluator-profile'])) throw new Error('campaign_evaluator_profile_outside_owner_mount');
        const profile = await json(values['evaluator-profile']);
        if (!ownerMount(profile.publicKeyPath) || typeof profile.receiptPath !== 'string' || profile.receiptPath.split('/').includes('..')) throw new Error('campaign_evaluator_profile_outside_owner_mount');
        attestEvaluation = await signedEvaluatorReceipt(profile);
      }
      let incidentTransport;
      if (manifest.data.classification === 'authorized-incident' && configuration.transport?.kind === 'none') throw new Error('campaign_transport_unavailable');
      if (manifest.data.classification === 'authorized-incident' && ['run', 'resume'].includes(command)) {
        if (!ownerMount(values['incident-transport'])) throw new Error('campaign_incident_authority_unavailable');
        const { readRsiDeploymentRecord } = await import('../../apps/server/src/rsiDeploymentAuthority.mjs');
        const { createRsiOssTransport } = await import('../../apps/server/src/rsiOssTransport.mjs');
        const transportConfig = await readRsiDeploymentRecord(values['incident-transport']);
        if (transportConfig.role !== 'lab') throw new Error('campaign_incident_authority_unavailable');
        incidentTransport = await createRsiOssTransport(transportConfig);
      }
      let result;
      if (command === 'preflight') result = await labPreflight(configuration, attestLab);
      else if (command === 'report') {
        const ready = await labPreflight(configuration, attestLab);
        result = ready.status === 'ready' ? await store.withCampaign(manifest.id, async (cp) => ({ status: 'checkpoint', checkpoint: cp.read() })) : ready;
      } else result = await runCampaign({ manifest, inputs: await json(values.inputs), configuration, store, attestLab, attestEvaluation, incidentTransport, statisticsModulePath: process.env.RSI_STATISTICS_PYTHONPATH ?? '/opt/evimed/rsi-python' });
      await emit(result);
      if (!['completed', 'ready', 'checkpoint', 'awaiting-evaluation'].includes(result?.status)) process.exitCode = 2;
    } finally { await database.close(); }
  }
}
