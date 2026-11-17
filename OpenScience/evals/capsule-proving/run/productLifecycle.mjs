/** Bounded product-path collection. A refusal is evidence about resources, not task reasoning. */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const codeOf = response => response?.json?.error?.code ?? response?.json?.code ?? response?.errorCode ?? response?.code ?? '';
export const projectRunName = (name, runId) => `${name} [${runId}]`;
export function runnerOutcome({ timedOut = false, status, code = '', correct, missingRecords = [] } = {}) {
  if (timedOut || /timeout|timed_out/i.test(code)) return 'timeout';
  if ([429, 503, 507].includes(status) || /cleanup_busy|capacity|resource.*(?:limit|refus)|quota|budget_exceeded/i.test(code)) return 'resource-refused';
  if (missingRecords.length || status === 404) return 'unobserved';
  if (correct === false) return 'task-failed';
  if (correct === true) return 'success';
  return status >= 400 ? 'runner-error' : 'observed';
}
/** A caller must supply its product's durable delete receipt reader; a 404 alone never proves settlement. */
export async function waitDeleteSettled({ read, attempts = 30, sleep = pause, delayMs = 1000 }) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('invalid_settlement_bound');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const receipt = await read();
    if (receipt?.state === 'settled' || receipt?.settled === true) return { outcome: 'observed', receipt, attempts: attempt };
    if (receipt?.state === 'failed') return { outcome: 'resource-refused', receipt, attempts: attempt };
    if (attempt < attempts) await sleep(delayMs);
  }
  return { outcome: 'timeout', missingRecords: ['delete-settled-receipt'], attempts };
}
export async function productCall({ call, beforeDispatch, verifyOwnedProject, retries = 3, sleep = pause, delayMs = 1000 }) {
  if (!Number.isSafeInteger(retries) || retries < 0) throw new Error('invalid_cleanup_retry_bound');
  if (beforeDispatch) {
    const settled = await beforeDispatch();
    if (settled?.outcome !== 'observed') return { ...settled, response: null, attempts: 0 };
  }
  const observations = [];
  let reverified404 = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try { response = await call(); }
    catch (error) {
      const code = error?.code ?? error?.name ?? 'transport_error';
      return { outcome: runnerOutcome({ timedOut: /timeout|abort/i.test(code), missingRecords: ['http-response'], code }),
        missingRecords: ['http-response'], attempts: attempt + 1, observations };
    }
    const code = codeOf(response);
    observations.push({ status: response.status, code });
    if (response.status === 404) {
      let owned = false;
      try { owned = verifyOwnedProject ? await verifyOwnedProject() : false; } catch { /* Missing ownership evidence never authorizes a retry. */ }
      if (!owned || reverified404 || attempt === retries) return { response, attempts: attempt + 1, observations, outcome: 'unobserved', missingRecords: ['owned-project-at-request'] };
      reverified404 = true;
    } else if (code !== 'cleanup_busy' || attempt === retries) return { response, attempts: attempt + 1, observations, outcome: runnerOutcome({ status: response.status, code }) };
    if (attempt < retries) await sleep(delayMs);
  }
}
