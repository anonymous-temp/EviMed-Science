import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const helper = fileURLToPath(new URL('../python/entry.py', import.meta.url));
const invalid = () => Object.assign(new Error('Unsupported clinical calculation input.'), { code: 'matching_compute_input_invalid' });
let libraryIdentity;

/** The actual packaged calculator bytes, shared by every native/host execution. */
export async function calculatorLibraryIdentity() {
  libraryIdentity ??= (async () => {
    const manifest = JSON.parse(await readFile(new URL('../python/calculators.sha256.json', import.meta.url), 'utf8'));
    const names = ['clinical_score_formulas.py', 'clinical_score_kit.py', 'clinical_score_points.py', 'clinical_score_verification.py', 'clinical_scores.py'];
    const verified = {};
    if (Object.keys(manifest).sort().join() !== names.join()) throw Object.assign(new Error('Calculator source inventory differs.'), { code: 'matching_compute_integrity_invalid' });
    for (const name of names) {
      const bytes = await readFile(new URL(`../python/clinical/${name}`, import.meta.url));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== manifest[name]) throw Object.assign(new Error('Calculator source integrity differs.'), { code: 'matching_compute_integrity_invalid' });
      verified[name] = digest;
    }
    const digest = createHash('sha256').update(JSON.stringify(verified)).digest('hex');
    return Object.freeze({ version: `source-${digest.slice(0, 16)}`, digest: `sha256:${digest}` });
  })().catch(error => { libraryIdentity = null; throw error; });
  return libraryIdentity;
}

/** Execute the same fixed calculator library shipped by the research MCP; no model-generated code.
 * @param {Record<string,any>} request @param {{signal?:AbortSignal,python?:string,timeoutMs?:number}} [options]
 * @returns {Promise<any>}
 */
export async function calculateClinicalScore(request, { signal, python = 'python3', timeoutMs = 5000 } = {}) {
  signal?.throwIfAborted();
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['action', 'filter', 'id', 'inputs', 'version', 'assume_absent'].includes(key))) throw invalid();
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > 262144) throw invalid();
  await calculatorLibraryIdentity();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', helper], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' } });
    const chunks = [];
    let bytes = 0;
    let failure;
    const abort = () => { failure = signal?.reason ?? Object.assign(new Error('Calculation canceled.'), { name: 'AbortError' }); child.kill('SIGTERM'); };
    const timer = setTimeout(() => { failure = Object.assign(new Error('Calculation timed out.'), { code: 'matching_compute_timeout' }); child.kill('SIGTERM'); }, Math.max(100, Math.min(30000, timeoutMs)));
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => { failure = Object.assign(new Error('Clinical calculation process is unavailable.'), { code: 'matching_compute_unavailable' }); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1048576) { failure = Object.assign(new Error('Calculation response exceeded its bound.'), { code: 'matching_compute_response_limit' }); child.kill('SIGTERM'); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(Object.assign(new Error('Clinical calculation failed.'), { code: 'matching_compute_failed' }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Clinical calculation returned an invalid response.'), { code: 'matching_compute_response_invalid' })); }
    });
    child.stdin.end(encoded);
  });
}
