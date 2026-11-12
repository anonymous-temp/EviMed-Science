#!/usr/bin/env node
/**
 * Board E round 3: builds the two extra FTS5 tables of a frozen collection from its own `documents` payloads (nothing is refetched).
 *
 *   terms_b   one row per trial (rowid = documents.id): title, condition, summary, description and the INCLUSION criteria only
 *             (`segmentCriteria`; unsectioned text counts as inclusion, exclusion text is left out; Kusa et al., JBI 2023).
 *   criteria + terms_c   one row per inclusion criterion: criteria(id, doc) and a contentless FTS5 `terms_c(text)` with
 *             rowid = criteria.id, text = `title | conditions | criterion` (TrialMatchAI's criterion-level index).
 *
 *   node index_r3.mjs --source <collection sqlite> [--target <sqlite>] [--max-criterion 600] [--seal <collection.json>]
 *
 * With no --target the tables are added to the source file itself (a collection database is rebuilt, re-hashed and re-sealed after
 * this, which `--seal <collection.json>` does: it checkpoints, re-hashes the file and writes the new databaseSha256 into the manifest). With --target the tables go to that file (experiment layout: documents stay in the source).
 * Idempotent: a target that already holds the tables is left as it is.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { segmentCriteria } from '../../packages/domain/src/vcrTrialJudgment.mjs';

export const TABLES_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS terms_b USING fts5(title,condition,summary,description,inclusion,content='',tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS criteria(id INTEGER PRIMARY KEY, doc INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS criteria_doc ON criteria(doc);
CREATE VIRTUAL TABLE IF NOT EXISTS terms_c USING fts5(text,content='',tokenize='porter unicode61');`;

/** The inclusion side of an eligibility text: the clauses of kind inclusion or unsectioned, in order. @param {string} eligibility */
export function inclusionClauses(eligibility) {
  return segmentCriteria(eligibility).filter((clause) => clause.kind !== 'exclusion').map((clause) => clause.text.replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

/**
 * @param {{ source: DatabaseSync, target: DatabaseSync, maxCriterion?: number }} io
 * @returns {{ trials: number, criteria: number }}
 */
export function buildTables({ source, target, maxCriterion = 600 }) {
  target.exec(TABLES_SQL);
  const done = Number(target.prepare('SELECT count(*) AS n FROM criteria').get()?.n ?? 0);
  if (done) return { trials: Number(target.prepare('SELECT count(*) AS n FROM terms_b').get()?.n ?? 0), criteria: done };
  const insertB = target.prepare('INSERT INTO terms_b(rowid,title,condition,summary,description,inclusion) VALUES (?,?,?,?,?,?)');
  const insertRow = target.prepare('INSERT INTO criteria(id,doc) VALUES (?,?)');
  const insertC = target.prepare('INSERT INTO terms_c(rowid,text) VALUES (?,?)');
  let trials = 0, criteria = 0;
  target.exec('BEGIN');
  try {
    for (const row of source.prepare('SELECT id, payload FROM documents ORDER BY id').iterate()) {
      const p = JSON.parse(inflateSync(/** @type {Buffer} */ (row.payload)).toString('utf8'));
      const clauses = inclusionClauses(p.eligibility ?? '');
      insertB.run(row.id, p.title ?? '', p.condition ?? '', p.summary ?? '', p.detailed_description ?? '', clauses.join('\n'));
      const head = `${p.title ?? ''} | ${String(p.condition ?? '').split('\n').filter(Boolean).join('; ')} | `;
      for (const clause of clauses) {
        criteria += 1;
        insertRow.run(criteria, row.id);
        insertC.run(criteria, head + clause.slice(0, maxCriterion));
      }
      trials += 1;
      if (trials % 50000 === 0) { target.exec('COMMIT'); target.exec('BEGIN'); console.error(`[index_r3] ${trials} trials, ${criteria} criteria`); }
    }
    target.exec('COMMIT');
  } catch (error) { target.exec('ROLLBACK'); throw error; }
  return { trials, criteria };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: o } = parseArgs({ options: { source: { type: 'string' }, target: { type: 'string' }, 'max-criterion': { type: 'string', default: '600' }, seal: { type: 'string' } } });
  if (!o.source) { console.error('--source is required'); process.exit(2); }
  const source = new DatabaseSync(o.source, { readOnly: Boolean(o.target) });
  const target = o.target ? new DatabaseSync(o.target) : source;
  if (o.target) { target.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA cache_size=-262144'); }
  const out = buildTables({ source, target, maxCriterion: Number(o['max-criterion']) });
  if (o.target) target.close();
  else if (o.seal) {
    source.exec('PRAGMA journal_mode=DELETE');
  }
  source.close();
  if (o.seal && !o.target) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(o.source)) hash.update(chunk);
    const manifest = JSON.parse(fs.readFileSync(o.seal, 'utf8'));
    fs.writeFileSync(o.seal, `${JSON.stringify({ ...manifest, databaseSha256: hash.digest('hex') }, null, 2)}\n`);
  }
  console.log(JSON.stringify(out));
}
