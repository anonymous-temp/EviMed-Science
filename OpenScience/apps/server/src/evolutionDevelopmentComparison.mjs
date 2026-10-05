import { validatePlatformSkillPackage } from './platformSkillPackage.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
/** Compare only explicitly visible development expectations, never evaluator assets.
 * @param {{execute:any,verification:any}} dependencies */
export function createEvolutionDevelopmentComparison({ execute, verification }) {
  return async (candidate, card, { signal = undefined } = {}) => {
    const cases = Array.isArray(card.developmentCases) ? card.developmentCases.filter(item => item && typeof item.id === 'string' && item.input && typeof item.input === 'object' && Object.hasOwn(item, 'expected')).slice(0, 20) : [];
    if (cases.some(item => ['tolerance', 'absoluteTolerance', 'relativeTolerance'].some(key => Object.hasOwn(item, key) && (!Number.isFinite(item[key]) || item[key] < 0)))) return { candidate, comparison: { status: 'invalid-development-case', ranked: false, options: [] } };
    const alternatives = Array.isArray(candidate.alternatives) ? candidate.alternatives.slice(0, 3) : [];
    if (!alternatives.length || !cases.length) return { candidate, comparison: { status: alternatives.length ? 'visible-cases-unavailable' : 'single-implementation', ranked: false, options: [] } };
    const options = [candidate, ...alternatives.map(option => ({ ...candidate, files: option.files, entrypoint: option.entrypoint, dependencies: option.dependencies ?? candidate.dependencies, alternatives: undefined }))], observations = [];
    for (const [index, option] of options.entries()) {
      const sourceDigest = digest(option.files ?? {}), bytes = Buffer.byteLength(canonicalJson(option.files ?? {}));
      const row = { index, sourceDigest, bytes, executed: false, agreement: 0, receipts: [], packageValid: false, packageIssues: /** @type {any[]} */ ([]) };
      observations.push(row);
      const packageCheck = validatePlatformSkillPackage(option, { card });
      row.packageValid = packageCheck.ok; row.packageIssues = packageCheck.issues;
      if (!packageCheck.ok) continue;
      if (!/^scripts\/[A-Za-z0-9_-]+\.py:[A-Za-z_][A-Za-z0-9_]*$/.test(option.entrypoint ?? '')) continue;
      const verified = await verification.verify(option, { signal });
      if (!verified.ok) continue;
      const [file, fn] = option.entrypoint.split(':');
      for (const testCase of cases) {
        const code = `import json,runpy,sys\nnamespace=runpy.run_path(${JSON.stringify('/candidate/' + file)},run_name='development_comparison')\nprint(json.dumps(namespace[${JSON.stringify(fn)}](**json.load(sys.stdin)),allow_nan=False))\n`;
        let result;
        try { result = await execute({ files: option.files, dependencyIds: option.dependencies ?? [], code, input: testCase.input }, { signal }); }
        catch (error) { if (signal?.aborted) throw error; continue; }
        if (result?.ok !== true || result?.joined !== true || result?.executionStarted !== true) continue;
        let actual; try { actual = JSON.parse(String(result.output).trim().split('\n').at(-1)); } catch { continue; }
        row.receipts.push({ caseId: testCase.id, outputDigest: digest(actual), sourceDigest });
        /** @param {any} a @param {any} b @returns {boolean} */
        const equal = (a, b) => typeof b === 'number' ? typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= (testCase.absoluteTolerance ?? testCase.tolerance ?? 1e-9) + (testCase.relativeTolerance ?? 0) * Math.abs(b) : Array.isArray(b) ? Array.isArray(a) && a.length === b.length && b.every((value, i) => equal(a[i], value)) : b && typeof b === 'object' ? a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => Object.hasOwn(a, key) && equal(a[key], b[key])) : a === b;
        if (equal(actual, testCase.expected)) row.agreement++;
      }
      row.executed = row.receipts.length === cases.length;
    }
    const ranked = observations.filter(row => row.executed).sort((a, b) => b.agreement - a.agreement || a.bytes - b.bytes || a.index - b.index);
    const selected = ranked[0];
    return { candidate: selected ? { ...options[selected.index], alternatives: undefined } : candidate, comparison: { status: selected ? 'compared' : 'no-complete-execution', ranked: !!selected, selectedDigest: selected?.sourceDigest, cases: cases.map(item => item.id), options: observations } };
  };
}
