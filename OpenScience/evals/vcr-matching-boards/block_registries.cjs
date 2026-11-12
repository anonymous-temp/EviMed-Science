// Preloaded (NODE_OPTIONS=--require) into the scenario server of the tool-failure scenario: a trial registry that cannot be reached.
// `fetch` to a registry host fails the way a refused connection does; every other host is untouched. No product code is changed.
// SCENARIO_BLOCK_LOG names a file that gets one line per blocked request, so the run can prove the failure was exercised.
const fs = require('node:fs');
const blocked = /(^|\.)(clinicaltrials\.gov|euclinicaltrials\.eu|chictr\.org\.cn|isrctn\.com|trialsearch\.who\.int)$/iu;
const real = globalThis.fetch;
globalThis.fetch = function fetchWithoutRegistries(input, init) {
  let host = '';
  try { host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).hostname; } catch { /* not a URL */ }
  if (host && blocked.test(host)) {
    if (process.env.SCENARIO_BLOCK_LOG) { try { fs.appendFileSync(process.env.SCENARIO_BLOCK_LOG, `${new Date().toISOString()} ${host}\n`); } catch { /* best effort */ } }
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause }));
  }
  return real.call(this, input, init);
};
