import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BENEFIT_RULE, decideSite, rowsDigest, siteConditions, summarizeSite } from './benefit.mjs';

/**
 * Writes one site's committed benefit record, `evals/judge-sites/<site>/benefit-2026-10-10.json`, from the private reports
 * `run.mjs --live --incumbent --output <file>` leaves: the rule and the plan's launch conditions applied to each pass, the
 * rows (ids, labels, outcomes and numbers; no case text), and the decision, which is `on` only when every pass says so.
 *
 *   node evals/judge-sites/write-benefit.mjs --site J3 --pass <report> [--pass <report>] [--before <report>] [--notes <json>]
 *
 * The record is what the calibration pin and `release-readiness.json` cite: its `resultsSha256` is the pin's `resultSha256`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback = null) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const options = (name) => argv.flatMap((value, index) => (value === name ? [argv[index + 1]] : []));
const site = option('--site');
const passFiles = options('--pass');
if (!site || !/^J\d+$/.test(site) || !passFiles.length) throw new Error('usage: --site J<n> --pass <report> [--pass <report>] [--before <report>] [--notes <json>]');
const USD_CNY = 6.7489; // the reference list's mid-rate (metering.mjs), the one every Jev cost in the ledger is converted at
const dir = path.join(root, 'evals/judge-sites', site);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const round = (value, digits) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);

const cases = new Map();
const caseFiles = [];
for (const name of ['cases.json', 'supplemental.json']) {
  try {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    const parsed = JSON.parse(text);
    caseFiles.push({ file: `evals/judge-sites/${site}/${name}`, sha256: sha(text) });
    for (const example of Array.isArray(parsed) ? parsed : parsed.cases) cases.set(example.id, example);
  } catch { /* supplemental.json is optional */ }
}
const labelOf = (example) => example?.expected ?? example?.expectedPartial ?? example?.expectedNot ?? example?.expectedAny ?? (example?.acceptableIds ? { acceptableIds: example.acceptableIds } : undefined);
/** A value small enough to keep; anything longer is kept as its digest. */
const small = (value) => {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text.length <= 240 ? value : { sha256: sha(text), bytes: text.length };
};
const enrich = (row) => ({ ...row, label: labelOf(cases.get(row.id)), jev: row.rawValue });
const compact = (row) => {
  const out = {
    id: row.id, ...(row.tag ? { tag: row.tag } : {}), ...(typeof row.source === 'string' ? { source: row.source.slice(0, 80) } : {}),
    label: small(row.label), outcome: row.outcome, ...(row.outcome !== 'settled' && row.code ? { code: row.code } : {}), ...(row.cause ? { cause: row.cause } : {}),
    ...(Number.isFinite(row.confidence) ? { confidence: round(row.confidence, 3) } : {}), jev: small(row.jev),
    ...(typeof row.correct === 'boolean' ? { correct: row.correct } : {}),
    ...(typeof row.hybridCorrect === 'boolean' ? { hybridCorrect: row.hybridCorrect } : {}),
    ...(typeof row.hybridBeforeCorrect === 'boolean' ? { hybridBeforeCorrect: row.hybridBeforeCorrect } : {}),
    ...(Number.isFinite(row.ms) ? { ms: row.ms } : {}), ...(Number.isFinite(row.cost) ? { costCny: round(row.cost, 7) } : {}),
  };
  if (row.incumbent) out.incumbent = { ...(row.incumbent.value !== undefined ? { value: small(row.incumbent.value) } : {}),
    ...(typeof row.incumbent.correct === 'boolean' ? { correct: row.incumbent.correct } : {}),
    ...(Number.isFinite(row.incumbent.ms) ? { ms: row.incumbent.ms } : {}), ...(Number.isFinite(row.incumbent.cost) ? { costCny: round(row.incumbent.cost, 7) } : {}),
    ...(row.incumbent.failure ? { failure: row.incumbent.failure } : {}) };
  if (site === 'J3') Object.assign(out, { finalRoute: row.finalRoute?.agentId, baselineFinalRoute: row.baselineFinalRoute?.agentId,
    ...(row.falseSpecialist ? { falseSpecialist: true } : {}), ...(row.baselineFalseSpecialist ? { baselineFalseSpecialist: true } : {}) });
  return out;
};

/** @param {string} file */
async function readPass(file) {
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  const rows = report.rows.filter((row) => row.site === site).map(enrich);
  const summary = summarizeSite(rows, { site });
  const { extraBar, constraints, basis } = siteConditions(site, rows, summary);
  const verdict = decideSite(summary, { extraBar, constraints });
  const compactRows = rows.map(compact);
  return { report, rows, summary, verdict, basis, compactRows };
}

const passes = [];
for (const [index, file] of passFiles.entries()) {
  const { report, summary, verdict, compactRows } = await readPass(file);
  passes.push({
    id: `pass-${index + 1}`, at: report.at, mode: report.mode, model: report.model, catalogCount: report.catalogCount ?? undefined, catalogDigest: report.catalogDigest ?? undefined,
    summary, checks: verdict.checks, decision: verdict.decision, reasons: verdict.reasons,
    spend: { jevUsd: round(compactRows.reduce((sum, row) => sum + (row.costCny ?? 0), 0) / USD_CNY, 4), deepseekBilledCny: round(report.incumbentMeter?.billedCny ?? 0, 4) },
    rowsSha256: rowsDigest(compactRows), rows: compactRows,
  });
}
const basis = siteConditions(site, [], summarizeSite([], { site })).basis;
const notes = option('--notes') ? JSON.parse(await fs.readFile(option('--notes'), 'utf8')) : {};
let before = null;
if (option('--before')) {
  const { summary } = await readPass(option('--before'));
  before = { note: notes.beforeNote ?? 'The first pass, scored on the labels as they stood before any correction.', summary };
}
const every = passes.every((pass) => pass.decision === 'on');
const record = {
  schemaVersion: 1,
  site,
  recordedAt: '2026-10-10',
  rule: { ...BENEFIT_RULE, siteConditions: basis ?? 'none named by the plan: the generic bar applies' },
  model: passes[0].model,
  corpus: { files: caseFiles, cases: cases.size, ...(notes.corpus ?? {}) },
  measuredOn: 'A development host in Taipei, where both providers answer a bare request in about 0.16 s. The production host is in Beijing: TypeSafe is reached there in 0.5 to 0.6 s (plan 2026-10-06 section 0), and a 325-token Jev request took 0.33 to 1.24 s on 2026-10-07 (4 requests, privateEvidence latency-production-host.json). Latency here compares the two paths on one network; it is not the production figure.',
  incumbentCostBasis: 'List prices (peak) from the reference price list on the tokens the provider reported. A repeated run of identical prompts is partly served from DeepSeek\'s prompt cache and costs less than a first call; production questions are new, so the first pass of a site is the representative one.',
  passes,
  ...(before ? { beforeLabelCorrection: before } : {}),
  decision: {
    value: every ? 'on' : 'original-path',
    heldBy: every ? null : [...new Set(passes.flatMap((pass) => pass.reasons))],
    resultsSha256: sha(passes.map((pass) => pass.rowsSha256).join('\n')),
    ...(notes.decision ?? {}),
  },
  ...(notes.notes ? { notes: notes.notes } : {}),
};
const target = path.join(dir, 'benefit-2026-10-10.json');
// Everything is indented, except that each row is one line: a pass is a hundred rows and a page of them is no easier to read, only longer.
const held = [];
const text = JSON.stringify(record, (key, value) => { if (key === 'rows' && Array.isArray(value)) { held.push(value); return `@@rows${held.length - 1}@@`; } return value; }, 2)
  .replace(/^(\s*)("rows": )"@@rows(\d+)@@"/gm, (_match, indent, name, index) => `${indent}${name}[\n${held[Number(index)].map((row) => `${indent}  ${JSON.stringify(row)}`).join(',\n')}\n${indent}]`);
JSON.parse(text);
await fs.writeFile(target, `${text}\n`);
process.stdout.write(`${site}: ${record.decision.value} (${passes.map((pass) => pass.decision).join(', ')}) ${path.relative(root, target)} ${(await fs.stat(target)).size} bytes resultsSha256 ${record.decision.resultsSha256}\n`);
