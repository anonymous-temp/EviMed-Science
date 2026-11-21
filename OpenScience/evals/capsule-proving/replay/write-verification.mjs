// Replay the production commit or existing-memory judge against recorded speakers.
import fs from 'node:fs/promises';
import { defaultDeepSeekModel } from '../../../apps/server/src/modelGateway.mjs';
import { NativeMemoryVerification } from '../../../apps/server/src/nativeMemoryVerification.mjs';
const cases = JSON.parse(await fs.readFile(new URL('../../../apps/server/test/fixtures/memory-verification-24.json', import.meta.url), 'utf8'));
const config = { deepseekBaseUrl: process.env.OPEN_SCIENCE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY, deepseekModel: process.env.WRT_JUDGE_MODEL || defaultDeepSeekModel };
if (!config.deepseekApiKey || cases.length !== 24) throw Error('supply the lab credential through DEEPSEEK_API_KEY and the recorded 24-case fixture');
const reviewer = new NativeMemoryVerification({ config, sessions: {}, overlay: {} });
if (process.argv[2] === '--stock') {
  // The stock worker fences the withdrawn row before batching. The integration and
  // unit tests exercise that fence and persistency; this replay measures judge quality.
  const visible = cases.filter(item => item.group !== 'withdrawn');
  const result = await reviewer.assess('wrt-lab', visible);
  for (const [i, row] of result.results.entries()) {
    const item = visible[i];
    const ok = item.expected === 'fix'
      ? ['corrected', 'attribution_wrong'].includes(row.status) && row.corrected !== item.text
      : row.status === item.expected;
    console.log(JSON.stringify({ provenance: item.provenance, input: item.text, expected: item.expected,
      rubric: item.rubric, actual: row.status, suggestion: row.corrected, verdictMatches: ok }));
    if (!ok) process.exitCode = 1;
  }
  console.log(JSON.stringify({ checked: visible.length, withheld: cases.length - visible.length, calls: result.calls }));
} else if (process.argv.length > 2) {
  throw Error('usage: node write-verification.mjs [--stock]');
} else for (const item of cases) {
  const after = [item.heading, '- ' + item.text].filter(Boolean).join('\n');
  const result = await reviewer.assessCommit('wrt-lab', [{ uri: 'recorded', type: item.heading ? 'project_context' : 'notes', before: '', after }], item.sources);
  const [row] = result.results;
  const stagePreserved = !item.heading || result.rewrites[0].after.endsWith(item.heading);
  const ok = stagePreserved && result.calls === 1 && !result.omitted && (item.expected === 'fix'
    ? ['corrected', 'attribution_wrong'].includes(row.status) && row.corrected !== item.text
    : row.status === item.expected && result.rewrites[0].after === after);
  console.log(JSON.stringify({ provenance: item.provenance, input: item.text, expected: item.expected, rubric: item.rubric,
    actual: row.status, correction: row.corrected, verdictMatches: ok }));
  if (!ok) process.exitCode = 1;
}
