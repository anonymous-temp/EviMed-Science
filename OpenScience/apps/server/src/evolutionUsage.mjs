import { createHash } from 'node:crypto';
/** Closed metadata from actual output; private output is never retained here. @param {any} output */
export function evolutionResultEvidence(output) {
  let value = output;
  if (typeof value === 'string') { try { value = JSON.parse(value.trim().split('\n').at(-1)); } catch { /* Text alone cannot establish a supported numerical result. */ } }
  const unsupported = node => node && typeof node === 'object' && ([node.status,node.code].some(state => ['unsupported','not_supported','not-supported','needs_input','unavailable','failed','error','refused','invalid_input','invalid-input'].includes(state)) || node.supported === false || typeof node.error === 'string' && node.error.trim());
  const substantive = (node, depth = 0) => {
    if (depth > 20 || unsupported(node)) return false;
    if (typeof node === 'number') return Number.isFinite(node);
    if (Array.isArray(node)) return node.some(item => substantive(item, depth + 1));
    if (!node || typeof node !== 'object') return false;
    if (typeof node.stdout === 'string' || typeof node.output === 'string') return evolutionResultEvidence(node.stdout ?? node.output).substantive;
    return Object.entries(node).some(([key,item]) => !['ok','status','code','exitCode','exit_code','duration','durationMs','elapsed','elapsedMs','stderr','warnings','logs'].includes(key) && substantive(item, depth + 1));
  };
  return { sha256: createHash('sha256').update(JSON.stringify(output) ?? 'null').digest('hex'), kind: value === null || value === undefined || value === '' ? 'empty' : typeof value === 'object' ? 'structured' : 'text',
    substantive: substantive(value), explicitlyUnsupported: Boolean(unsupported(value)) };
}
/** A supported result means an actual substantive tool output in a completed, nonempty run.
 * It does not assert scientific validity, empirical validation, or a quality-gate pass.
 * @param {any} use @param {any} run @param {any} transcript */
export function evolutionCompletedResult(use, run, transcript) {
  if (!['succeeded','delivered','failed','canceled','cancelled'].includes(run.status)) return { supported: null, resultState: 'pending' };
  const delivered = (run.artifacts ?? []).length > 0 || (run.unverifiedArtifacts ?? []).length > 0 || (run.deliverables ?? []).some(item => item.artifactPath || item.path || item.files?.length);
  const answer = transcript?.header?.completeness === 'complete' && transcript.messages?.some(message => message.role === 'assistant' && message.parts?.some(part => part.type === 'text' && part.text?.trim()));
  const completed = ['succeeded','delivered'].includes(run.status) && Boolean(delivered || answer);
  const noResult = !['succeeded','delivered'].includes(run.status) || (!delivered && transcript?.header?.completeness === 'complete' && !answer);
  const supported = noResult || use.result?.ok === false || use.resultEvidence?.explicitlyUnsupported ? false : completed && use.resultEvidence?.substantive === true ? true : null;
  return { supported, resultState: supported === true ? 'supported-completed-tool-result' : supported === false ? 'no-supported-completed-result' : 'result-evidence-unknown',
    resultScope: 'completed-run-with-substantive-tool-output', runStatus: run.status };
}
