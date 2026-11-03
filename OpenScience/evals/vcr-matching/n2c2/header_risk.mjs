#!/usr/bin/env node
/**
 * How often a fact is dated to the wrong record, in the dataset's own terms (a read made after the scoring; no gold is involved and nothing
 * here is in the frozen code). Every n2c2 record opens with a `Record date:` line, so the record a fact sits in is known: the nearest such
 * line above its quotation. The product's header (`clinicalRecordHeader`) is any short line with one date; this counts the facts for which
 * it chose another line than the record's own, and how far the two dates are apart.
 *
 *   node header_risk.mjs --run <name> --split heldout [--data-root <dir>]
 *
 * Prints counts only: no note text, no quotation.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { acceptExtractedFacts } from '@evimed/domain';
import { settleFactEvidence } from '../../../apps/server/src/vcrMatching.mjs';
import { VARIABLES } from './criteria.mjs';
import { dataPaths, dataRoot, developmentIds, patientIds, readPatient } from './data.mjs';

const { values } = parseArgs({ options: { run: { type: 'string' }, split: { type: 'string' }, 'data-root': { type: 'string' } } });
const root = dataRoot(values['data-root']);
const paths = dataPaths(root);
const train = await patientIds(paths.trainDir);
const dev = developmentIds(train);
const ids = values.split === 'dev' ? dev : train.filter((id) => !dev.includes(id));

/** The date of the dataset's own record line above `position`. @param {string} text @param {number} position */
function recordDateAbove(text, position) {
  let found = null;
  for (const match of text.slice(0, position).matchAll(/^Record date: (\d{4}-\d{2}-\d{2})[ \t]*$/gm)) found = match[1];
  return found;
}

const tally = { facts: 0, byHeader: 0, ownRecordLine: 0, otherShortLine: 0, otherLineSameDateAsRecord: 0, wrongRecord: 0, noRecordLine: 0, laterThanRecord: 0, earlierThanRecord: 0 };
/** @type {number[]} */
const apart = [];
for (const id of ids) {
  const raw = JSON.parse(await readFile(path.join(paths.runs, values.run, 'raw', `${id}.json`), 'utf8'));
  if (raw.unreadable) continue;
  let answer;
  try { answer = JSON.parse(raw.content); } catch { continue; }
  const patient = await readPatient(paths.trainDir, id);
  const documents = new Map([['note', { id: 'note', text: patient.text }]]);
  for (const item of acceptExtractedFacts(answer, new Set(Object.keys(VARIABLES))).facts) {
    const start = patient.text.indexOf(item.quote);
    if (start < 0) continue;
    const settled = settleFactEvidence({ id: 'f', subjectKey: id, variable: item.variable, polarity: item.polarity, value: item.value ?? null, unit: item.unit ?? null,
      occurredAt: item.occurredAt ?? null, recordedAt: null, surface: item.surface, dateSurface: item.dateSurface ?? null,
      source: { documentId: 'note', start, end: start + item.quote.length, quote: item.quote }, extractedBy: 'model', provenance: { schema: 1, status: 'batch_extraction', factSchema: 2 } },
    { documents, anyPolarity: true, ...(patient.asOf ? { asOf: patient.asOf } : {}) });
    if (!settled.ok) continue;
    tally.facts += 1;
    if (!settled.notes.includes('date_from_record_header')) continue;
    tally.byHeader += 1;
    const own = recordDateAbove(patient.text, start);
    const usedRecordLine = /^Record date:/.test(settled.fact.source.dateQuote.quote);
    if (usedRecordLine) tally.ownRecordLine += 1; else tally.otherShortLine += 1;
    if (own === null) { tally.noRecordLine += 1; continue; }
    if (settled.fact.occurredAt === own) { if (!usedRecordLine) tally.otherLineSameDateAsRecord += 1; continue; }
    tally.wrongRecord += 1;
    const days = Math.round((Date.parse(settled.fact.occurredAt) - Date.parse(own)) / 86_400_000);
    if (days > 0) tally.laterThanRecord += 1; else tally.earlierThanRecord += 1;
    apart.push(Math.abs(days));
  }
}
apart.sort((a, b) => a - b);
const quantile = (/** @type {number} */ p) => (apart.length ? apart[Math.min(apart.length - 1, Math.floor(p * apart.length))] : null);
process.stdout.write(`${JSON.stringify({ run: values.run, patients: ids.length, ...tally, dayDifference: { median: quantile(0.5), p90: quantile(0.9), max: apart.at(-1) ?? null } }, null, 2)}\n`);
