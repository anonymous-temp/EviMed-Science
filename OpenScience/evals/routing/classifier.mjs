// Live: the open-domain routing decision (`routeOpenDomain`) over evals/routing/cases.json, three samples each, with the
// production classifier on the configured DeepSeek model and the production capability registry as its catalog. A case
// passes only when every sample is one `expect` accepts ("none", the specialist id, or a list of right answers). Writes results/<date>-classifier.json
// and exits 1 on any case that went the other way.
//
//   OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=<file> node evals/routing/classifier.mjs [--samples 3] [--concurrency 4] [--out <dir>]
//
// Jev (the J3 judge site) is not in this path: it is measured by run.mjs. What a structured choice does (the shell's picker,
// a session bound to a capability) is covered by the dispatch integration tests, since it never reaches a model.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const server = path.join(root, 'apps/server/src');
const { loadConfig } = await import(path.join(server, 'config.mjs'));
const { loadAgentRegistry } = await import(path.join(server, 'agentRegistry.mjs'));
const { SpecialistClassifier } = await import(path.join(server, 'specialistClassifier.mjs'));
const { routeOpenDomain, OPEN_DOMAIN_ANSWER_AGENT_ID } = await import(path.join(server, 'specialistRouting.mjs'));

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : Number(argv[index + 1]); };
const samples = option('--samples', 3);
const concurrency = Math.max(1, Math.min(8, option('--concurrency', 4)));
const outDir = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : path.join(here, 'results');

const { cases } = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'));
const config = { ...loadConfig({ rootDir: root, requireDurableUsageLedger: false }), llmRoutingEnabled: true, deepseekProviderEnabled: true };
if (!config.deepseekApiKey) throw new Error('no DeepSeek key configured (OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE)');
const registry = await loadAgentRegistry({ packageDirs: config.agentPackageDirs, capabilityDirs: config.capabilityDirs });
const agents = registry.list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
const classifier = new SpecialistClassifier(config);

async function sample(item) {
  const trace = {};
  const { specialist, decidedBy } = await routeOpenDomain({ query: item.message, agents, classifier, trace });
  return { agentId: specialist?.agentId ?? 'none', decidedBy, reason: specialist?.reason ?? null, verdict: trace.verdict ?? null, failure: trace.failure ?? null };
}

const results = new Array(cases.length);
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < cases.length) {
    const index = next++;
    const item = cases[index];
    const runs = [];
    // A structured choice never reaches the model, so repeating it would only repeat a lookup.
    for (let n = 0; n < (/^\s*\//.test(item.message) ? 1 : samples); n += 1) runs.push(await sample(item));
    results[index] = { id: item.id, source: item.source, message: item.message, expect: item.expect, runs,
      passed: runs.every((run) => [item.expect].flat().includes(run.agentId)) };
  }
}));

let wrong = 0;
for (const result of results) {
  if (!result.passed) wrong += 1;
  console.log(result.passed ? 'ok  ' : 'FAIL', result.id.padEnd(14), result.runs.map((run) => run.agentId).join(','), '| expect', [result.expect].flat().join('|'), '|', result.message.slice(0, 60));
}
const failures = results.reduce((sum, result) => sum + result.runs.filter((run) => run.failure).length, 0);
console.log(`${results.length - wrong}/${results.length} cases passed in every sample (${samples} samples; ${failures} classifier failures)`);
const day = new Date().toISOString().slice(0, 10);
const out = path.join(outDir, `${day}-classifier.json`);
await mkdir(outDir, { recursive: true });
await writeFile(out, `${JSON.stringify({ ranAt: new Date().toISOString(), model: config.deepseekModel, samples, catalog: agents.length,
  summary: { cases: results.length, passed: results.length - wrong, classifierFailures: failures }, results }, null, 1)}\n`);
console.log(`wrote ${out}`);
process.exitCode = wrong ? 1 : 0;
