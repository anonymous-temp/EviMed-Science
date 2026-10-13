// Live: the net's statement question (`SpecialistClassifier.net`) over evals/routing/statements.json, three samples
// each, on the configured DeepSeek model. Writes results/<date>-statements.json; exits 1 on any case that went the
// other way. Needs OPEN_SCIENCE_DEEPSEEK_API_KEY(_FILE).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '../../apps/server/src');
const { loadConfig } = await import(path.join(server, 'config.mjs'));
const { SpecialistClassifier } = await import(path.join(server, 'specialistClassifier.mjs'));
const { cases } = JSON.parse(await readFile(path.join(here, 'statements.json'), 'utf8'));
const config = { ...loadConfig({}), llmRoutingEnabled: true, deepseekProviderEnabled: true };
if (!config.deepseekApiKey) throw new Error('no DeepSeek key configured');
const agents = [...new Set(cases.map((item) => item.net))].map((id) => ({ id, version: '1', runtimeAgent: id }));
const classifier = new SpecialistClassifier(config);
const results = [];
let wrong = 0;
for (const item of cases) {
  const verdicts = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const trace = { verdict: 'none' };
    const routed = await classifier.net(item.message, agents, trace);
    verdicts.push(routed ? routed.agentId : trace.statement ? 'yielded' : 'none');
  }
  const passed = verdicts.every((verdict) => (item.expect === 'yield' ? verdict === 'yielded' : verdict === item.net));
  if (!passed) wrong += 1;
  results.push({ message: item.message, net: item.net, verdicts });
  console.log(passed ? 'ok  ' : 'FAIL', verdicts.join(','), '|', item.message);
}
const day = new Date().toISOString().slice(0, 10);
await writeFile(path.join(here, 'results', `${day}-statements.json`),
  `${JSON.stringify({ ranAt: new Date().toISOString(), model: config.deepseekModel, samples: 3, results }, null, 1)}\n`);
process.exitCode = wrong ? 1 : 0;
