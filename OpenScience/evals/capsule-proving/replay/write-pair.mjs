// Compare two already configured lab engines. Only synthetic development conversations belong here.
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';
import { loadCases } from '../run/cases.mjs';
import { openLab } from '../run/lab.mjs';
import { memoryLines } from '../../../apps/server/src/nativeMemoryOverlay.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const arms = ['old', 'next'];
const labels = ['user', 'assistant_as_user', 'unadopted', 'material', 'other_error', 'structure'];

function* sectionLines(body) {
  let heading = '';
  for (const raw of String(body ?? '').split('\n')) {
    const [line] = memoryLines(raw);
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) heading = line;
    yield { heading, line };
  }
}

export function addedLines(before, after) {
  return Object.entries(after).flatMap(([file, body]) => {
    const counts = new Map();
    for (const row of sectionLines(before[file])) {
      const key = JSON.stringify(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const added = [];
    for (const row of sectionLines(body)) {
      const key = JSON.stringify(row);
      if (counts.get(key) > 0) counts.set(key, counts.get(key) - 1);
      else added.push({ file, ...row });
    }
    return added;
  });
}

// Reviewers label every added line against the conversation through its checkpoint.
// Targets are declared before running, then checked against the final files in both arms.
export function score(record, review) {
  if (review.digest !== digest(record)) throw Error('review belongs to a different extraction');
  const counts = {}, covered = {};
  for (const arm of arms) {
    const rows = record.rows.filter(row => row.arm === arm);
    if (!rows.length || rows.some(row => !labels.includes(review.labels[row.id]))) throw Error('incomplete line review');
    counts[arm] = { lines: rows.filter(r => review.labels[r.id] !== 'structure').length, assistantAsUser: 0, forbidden: 0, otherErrors: 0 };
    if (!counts[arm].lines) throw Error('no substantive additions to compare');
    for (const { id } of rows) {
      const label = review.labels[id];
      if (label === 'assistant_as_user') counts[arm].assistantAsUser++;
      if (['assistant_as_user', 'unadopted', 'material'].includes(label)) counts[arm].forbidden++;
      if (label === 'other_error') counts[arm].otherErrors++;
    }
    covered[arm] = {};
    for (const target of record.targets) {
      const answer = review.targets[arm][target.id];
      if (answer === false) { covered[arm][target.id] = false; continue; }
      const body = record.final[arm][target.user]?.[answer?.file];
      if (!answer?.line || !memoryLines(body).includes(answer.line)) throw Error('missing target decision or evidence');
      covered[arm][target.id] = true;
    }
  }
  const next = counts.next, old = counts.old;
  const recovered = record.targets.filter(t => t.kind === 'miss' && !covered.old[t.id] && covered.next[t.id]).length;
  return { counts, covered, recovered, pass: Object.values(covered.next).every(Boolean) && recovered >= 4 &&
    next.assistantAsUser * old.lines <= old.assistantAsUser * next.lines && !next.forbidden && !next.otherErrors };
}

async function main() {
  const { values: args } = parseArgs({ options: Object.fromEntries(['score', 'review', 'out', 'data', 'users', 'targets',
    'old', 'next', 'old-mount', 'next-mount', 'engine-key-file', 'database-url-file'].map(key => [key, { type: 'string' }])) });
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  if (args.score) {
    const result = score(await read(args.score), await read(args.review));
    console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
    return;
  }
  if (!args.out || !args.old || !args.next || new URL(args.old).origin === new URL(args.next).origin) throw Error('supply separate old/next lab engines and a fresh --out directory');
  const cases = await loadCases({ set: 'synthetic-users', split: 'dev', dataDir: args.data, only: args.users });
  if (cases.length !== 2 || cases.some(item => !item.sessions.length)) throw Error('select both recorded development users with --users');
  const targets = await read(args.targets);
  if (!Array.isArray(targets) || targets.filter(t => t.kind === 'miss').length < 4 || !targets.some(t => t.kind === 'history') ||
    new Set(targets.map(t => t.id)).size !== targets.length || targets.some(t => !t.id || !t.rubric || !['miss','history'].includes(t.kind) ||
      !cases.some(item => item.userKey === t.user && item.sessions.some(s => s.sessionId === t.session)))) throw Error('predeclare user/session, rubric and unique id for each history and missed target');
  const mountDigests = {};
  const candidate = renderMemoryTemplates({ variant: 'next' });
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const arm of arms) {
    const directory = args[arm + '-mount'];
    const names = (await fs.readdir(directory)).filter(n => n.endsWith('.yaml')).sort();
    if (names.join() !== Object.keys(candidate).sort().join()) throw Error('unexpected template file set');
    const manifest = {};
    for (const name of names) {
      const bytes = await fs.readFile(path.join(directory, name), 'utf8');
      const expected = arm === 'next' ? candidate[name] : execFileSync('git', ['show',
        'aec6d6e7e:OpenScience/deploy/web/openviking/memory-templates/' + name], { cwd, encoding: 'utf8' });
      if (bytes !== expected) throw Error('wrong mounted template bytes: ' + arm + '/' + name);
      manifest[name] = digest(bytes);
    }
    mountDigests[arm] = digest(manifest);
  }
  await fs.mkdir(args.out, { mode: 0o700 });
  const record = { mountDigests, targets, inputs: cases.map(c => ({ user: c.userKey, sessions: c.sessions })), rows: [], final: {} };
  for (const arm of arms) {
    const account = 'evlab-wrt-' + randomUUID();
    const lab = await openLab({ engineUrl: args[arm], engineKeyFile: args['engine-key-file'], databaseUrlFile: args['database-url-file'], account });
    try {
      record.final[arm] = {};
      for (const item of cases) {
        const user = await lab.user(item.userKey);
        let files = (await lab.snapshot(user)).files;
        if (Object.keys(files).length || lab.facts.templatesMounted !== true) throw Error('expected a fresh namespace and mounted templates');
        for (const session of item.sessions) {
          const receipt = await lab.ingestSession(user, session);
          if (receipt.ledger?.state !== 'completed') throw Error('session did not settle');
          const next = (await lab.snapshot(user)).files;
          for (const row of addedLines(files, next)) record.rows.push({ id: String(record.rows.length), arm, user: item.userKey, session: session.sessionId, ...row });
          files = next;
        }
        record.final[arm][item.userKey] = files;
      }
    } finally { await lab.close(); }
  }
  const decisions = () => Object.fromEntries(targets.map(t => [t.id, null]));
  const review = { digest: digest(record), labels: Object.fromEntries(record.rows.map(r => [r.id, null])), targets: { old: decisions(), next: decisions() } };
  for (const [name, value] of Object.entries({ record, review })) await fs.writeFile(args.out + '/' + name + '.json', JSON.stringify(value, null, 2), { mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
