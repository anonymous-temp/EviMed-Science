import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { loadAgentRegistry } from '../../apps/server/src/agentRegistry.mjs';
import { createJudgeService } from '../../apps/server/src/judgeService.mjs';
import { SpecialistClassifier } from '../../apps/server/src/specialistClassifier.mjs';
import { decideRouting } from '../../apps/server/src/routingDecision.mjs';
import { createMeter } from './incumbents.mjs';

/**
 * What a person waiting on a dispatch pays when Jev is down or slow, with the real DeepSeek classifier behind it: the production
 * classifier and routing decision over the real capability registry, 12 questions of the J3 corpus, three ways. Jev is a local
 * socket that refuses connections, or one that accepts and never answers; it is never TypeSafe, and the key it is given is a dummy.
 *
 *   OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=<file> node evals/judge-sites/online-fallback-check.mjs
 *
 * Expected, and measured on 2026-10-10: the same routes as Flash alone; a refused Jev adds nothing once its circuit is open (three
 * failures, five minutes); a silent one costs each of the first three dispatches the online timeout (3000 ms by default,
 * OPEN_SCIENCE_JEV_ONLINE_TIMEOUT_MS) and the rest nothing.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = loadConfig({ rootDir: root, requireDurableUsageLedger: false, typesafeApiKey: 'dummy-not-a-key' });
const registry = await loadAgentRegistry({ packageDirs: base.agentPackageDirs, capabilityDirs: base.capabilityDirs });
const agents = registry.list().filter((agent) => agent.id !== 'open-domain-answer');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'evals/judge-sites/J3/cases.json'), 'utf8')).cases
  .filter((example) => example.tag !== 'title-to-paper').filter((_, index) => index % 7 === 0).slice(0, 12);

const silent = http.createServer(() => { /* accepts, never answers */ });
await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));

async function run(label, apiBase) {
  const meter = createMeter();
  const config = { ...base, reviewJevApiBase: apiBase };
  const judge = apiBase ? createJudgeService({ config }) : null;
  const classifier = new SpecialistClassifier({ ...config, llmRoutingEnabled: true }, { judgeService: judge, fetchImpl: meter.fetchImpl });
  const times = [];
  const routes = [];
  for (const example of cases) {
    const started = Date.now();
    const result = await decideRouting({ question: example.input.question, agents, classifier, owner: { userId: 'judge-check', projectId: 'judge-check' } });
    times.push(Date.now() - started);
    routes.push(result.capability?.id ?? 'none');
  }
  const sorted = [...times].sort((a, b) => a - b);
  const at = (quantile) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  process.stdout.write(`${label}: n=${times.length} p50=${at(0.5)} ms p95=${at(0.95)} ms; per dispatch ${times.join(', ')}; DeepSeek calls ${meter.totals.calls}\n`);
  await judge?.close();
  return routes;
}
const flash = await run('Flash alone', '');
const refused = await run('Jev refuses connections', 'http://127.0.0.1:9/v1');
const hung = await run(`Jev accepts and never answers (online timeout ${base.jevOnlineTimeoutMs} ms)`, `http://127.0.0.1:${silent.address().port}/v1`);
process.stdout.write(`the same routes as Flash alone: refused ${JSON.stringify(refused) === JSON.stringify(flash)}, silent ${JSON.stringify(hung) === JSON.stringify(flash)}\n`);
silent.closeAllConnections?.();
silent.close();
