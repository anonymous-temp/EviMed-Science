/** Read-only deploy impact. Usage: node scripts/ops/correction-precedence-report.mjs --database-url-file /private/database.url
 * Reports ids/titles only, per account. No migrations, application boot, model calls or writes. Never run against production during development.
 * Legacy recovery under the switch is conditional on a separate coverage judgement; the report cannot predict that judgement.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { methodPersonCorrection, legacyCorrectionRecoverable, correctionOrder } from '../../apps/server/src/learningService.mjs';

const title = row => String(row.payload?.display?.title ?? row.payload?.frontmatter?.name ?? row.id);
const identity = row => ({ id: row.id, title: title(row) });

/** Pure snapshot report, also used by the regression tests. */
export function correctionImpact(methods, jobs, revisions = []) {
  const accounts = [...new Set(methods.map(row => row.userId))].sort();
  return accounts.map(accountId => {
    const library = methods.filter(row => row.userId === accountId && !row.deletedAt && row.payload?.recordType === 'learned-method');
    const modes = {};
    for (const verified of [false, true]) {
      const recover = library.filter(row => row.payload.status === 'candidate' && !row.payload.conflictHold
        && (verified ? legacyCorrectionRecoverable(row.payload, revisions.filter(old => old.userId === accountId && old.id === row.id))
          : Boolean(methodPersonCorrection(row.payload))));
      const holds = new Map();
      for (const winner of library) {
        const proof = methodPersonCorrection(winner.payload, verified);
        if (!proof || winner.payload.status !== 'approved' && !recover.includes(winner)) continue;
        for (const loser of library) {
          if (loser.id === winner.id || loser.payload.status !== 'approved') continue;
          const conflict = (a, b) => (a.payload.learning?.relations ?? []).some(edge => edge.type === 'conflicts_with' && !edge.resolved && edge.target === b.id);
          if (!conflict(winner, loser) && !conflict(loser, winner)) continue;
          const other = methodPersonCorrection(loser.payload, verified);
          const wins = !other || (verified ? correctionOrder(proof, other) > 0 || correctionOrder(proof, other) === 0 && winner.id > loser.id
            : `${proof.at}:${winner.id}` > `${other.at}:${loser.id}`);
          if (wins) holds.set(loser.id, identity(loser));
        }
      }
      const replay = jobs.filter(job => job.userId === accountId && ['queued', 'running'].includes(job.status)
        && job.payload?.action === 'replay').flatMap(job => {
        const method = library.find(row => row.id === job.payload.methodId && row.payload.contentDigest === job.payload.digest && row.payload.status !== 'retired');
        return method && methodPersonCorrection(method.payload, verified) ? [{ id: job.id, title: title(method) }] : [];
      });
      const rows = { legacyRecovery: recover.map(identity), conflictDemotion: [...holds.values()], replayUnjudged: replay };
      modes[verified ? 'switchOn' : 'switchOff'] = { counts: Object.fromEntries(Object.entries(rows).map(([key, list]) => [key, list.length])), ...rows };
    }
    return { accountId, ...modes };
  });
}

export async function readCorrectionSnapshot(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const methods = await client.query(`SELECT user_id AS "userId", id, payload FROM evimed_product.documents
      WHERE kind='method' AND deleted_at IS NULL AND payload->>'recordType'='learned-method'`);
    const jobs = await client.query(`SELECT user_id AS "userId", id, payload, status FROM evimed_product.jobs
      WHERE kind='consolidate' AND status IN ('queued','running') AND payload->>'action'='replay'`);
    const history = await client.query(`SELECT r.user_id AS "userId", r.id, r.payload, r.deleted_at AS "deletedAt" FROM evimed_product.revisions r
      JOIN evimed_product.documents d USING (user_id,kind,id)
      WHERE r.kind='method' AND d.deleted_at IS NULL AND d.payload->>'recordType'='learned-method' AND d.payload->>'status'='candidate'`);
    return correctionImpact(methods.rows, jobs.rows, history.rows);
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--database-url-file') throw new Error('Usage: --database-url-file PATH');
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({ connectionString: (await readFile(args[1], 'utf8')).trim(),
    options: '-c default_transaction_read_only=on', application_name: 'correction-precedence-readonly-report' });
  try {
    await client.connect();
    process.stdout.write(JSON.stringify({ mode: 'read-only', legacyRecoveryOn: 'requires independent coverage judgement', accounts: await readCorrectionSnapshot(client) }, null, 2) + '\n');
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('Read-only correction report failed; verify the database file, access and schema.\n');
  process.exitCode = 1;
});
