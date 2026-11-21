// S-A07 exercises the product worker, real extractor, pinned plugin and resident opening.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const names = ['base', 'engine-url', 'engine-key-file', 'database-url-file', 'deepseek-key-file', 'plugin-tgz', 'out'];
const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
  'deferred-summary-rebuild': { type: 'boolean', default: false }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node evals/capsule-proving/pp/safety-opening.mjs ' + names.map(name => '--' + name + ' <value>').join(' ') + ' [--deferred-summary-rebuild]');
  console.log('Use the same local safety-enabled lab stack for both URLs. Allow for extraction and the real 301-second cooldown.');
  process.exit(0);
}
for (const name of names) assert.ok(values[name], 'Missing --' + name);
for (const name of ['base', 'engine-url']) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(values[name]).hostname), 'Local lab only');
const { openLab, replaceLabFile } = await import('../run/lab.mjs');
const { buildProfileBlock } = await import('../run/openingBlock.mjs');
const checks = new Map([
  ['ready', 'running control plane verified the safety template and policy'],
  ['policy', 'fresh engine identity already allows safety extraction'],
  ['binding', 'legacy copy identifies the original file and exact line'],
  ['selection', 'coffee preference was excluded from the projection'],
  ['extraction', 'new latex card preserves the negative condition and has a dated receipt'],
  ['source', 'new card revision identifies the project, session and archive of extraction'],
  ['profile', 'pinned plugin truncated the long profile'],
  ['legacyOpening', 'project B opening includes the migrated statement, source and date'],
  ['freshOpening', 'project B opening includes the whole new safety card'],
  ['pointer', 'oversize card exposes its title and pointer'],
  ['full', 'project B can read the final condition'],
  ['forget', 'gateway confirms removal of one line'],
  ['neighbour', 'source neighbour remains and the bound projection is gone'],
  ['cards', 'all raw safety cards omit iohexol and retain latex'],
  ['opening', 'project B opening omits iohexol and retains latex'],
  ['retry', 'eligible migration leaves all safety cards and the opening clean'],
  ['cleanup', 'synthetic account and user removed'],
]);
const report = { run: 'safe-' + randomUUID(), deferred: values['deferred-summary-rebuild'], checks: [], stages: [], pass: false };
let lab;
const errorOf = error => lab ? lab.redact(String(error?.message ?? error)) : String(error?.code ?? error?.name ?? 'failed');
async function stage(name, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    report.stages.push({ name, ok: true, ms: Math.round(performance.now() - start) });
    return result;
  } catch (error) {
    report.stages.push({ name, ok: false, ms: Math.round(performance.now() - start), error: errorOf(error) });
    return undefined;
  }
}
async function check(id, evaluate) {
  const name = checks.get(id);
  try { report.checks.push({ id, name, pass: Boolean(await evaluate()) }); }
  catch (error) { report.checks.push({ id, name, pass: false, error: errorOf(error) }); }
}
try {
  await check('ready', async () => {
    const response = await fetch(new URL('/api/ready', values.base), { signal: AbortSignal.timeout(30000) });
    const templates = (await response.json())?.data?.checks?.memoryIndex?.engine?.facts?.memoryTemplates;
    return response.ok && templates?.ok && templates.types.includes('safety_notes');
  });
  lab = await openLab({ engineUrl: values['engine-url'], engineKeyFile: values['engine-key-file'], databaseUrlFile: values['database-url-file'],
    deepseekKeyFile: values['deepseek-key-file'], account: 'evlab-' + report.run, historySearch: false, engineTimeoutMs: 120000,
    configOverrides: { memorySafetyNotesEnabled: true, memorySafetyNotesMigrationEnabled: true, memoryForgetTargetsEnabled: true,
      memoryDeferredSummaryRebuildEnabled: report.deferred } });
  const user = await lab.user('owner'), { sessions, client, worker, overlay, nativeMemory } = lab.parts;
  const id = user.userId;
  await check('policy', () => lab.facts.policyRewritten === 0 && lab.facts.memoryTypes.includes('safety_notes'));
  const a = { id: 'study-a', name: 'First study' }, b = { id: 'study-b', name: 'Second study' };
  const writer = lab.memoryFor(user, { project: a, executeForget: true }), reader = lab.memoryFor(user, { project: b });
  const legacy = '我本人对碘海醇过敏，不能使用碘海醇。';
  const legacyPath = 'people/old-owner.md';
  const uri = sessions.memoryRoot(id) + '/' + legacyPath;
  await stage('plantLegacy', async () => {
    await sessions.ensureTypeDirectory(id, 'people');
    await replaceLabFile(lab.parts, user, legacyPath, '# 我本人\n- ' + legacy + '\n- 我对咖啡没兴趣。');
    await sessions.setTags(id, uri, ['project=' + a.id]);
    await overlay.upsertFile({ userId: id, uri, memoryType: 'people', projectId: a.id });
  });
  const scanInstant = async () => (await lab.parts.database.query(
    'SELECT safety_scan_at FROM evimed_memory.native_accounts WHERE user_id=$1', [id])).rows[0]?.safety_scan_at?.toISOString();
  await stage('firstMigration', () => worker.migrateSafety(id));
  report.firstScanAt = await stage('firstScanReceipt', scanInstant);
  const migrated = await stage('findProjection', async () => (await nativeMemory.safetyNotes(id, b.id)).find(file => file.sourceUri === uri && file.body.includes(legacy)));
  await check('binding', () => migrated?.lineHashes.includes(createHash('sha256').update('- ' + legacy).digest('hex')));
  await check('selection', () => migrated && !migrated.body.includes('咖啡'));

  const saidAt = new Date().toISOString();
  const ingested = await stage('extract', () => lab.ingestSession(user, { sessionId: 'new-fact', project: a, at: saidAt,
    messages: [{ role: 'user', text: '请记住，我本人对乳胶过敏，不能使用乳胶手套。', at: saidAt }] }));
  const fresh = await stage('findNewCard', async () => (await nativeMemory.safetyNotes(id, b.id)).find(file => !file.sourceUri && file.type === 'safety_notes' && file.body.includes('乳胶')));
  await check('extraction', () => fresh?.originalSources.length && fresh.updatedAt && /过敏/.test(fresh.body) && /不能|禁止|避免|不可/.test(fresh.body));
  await check('source', async () => fresh && ingested && (await overlay.revisionsOf(id, fresh.uri)).some(revision =>
    revision.archiveUri === ingested.commit.archiveUri && revision.engineSession === ingested.engineSession && revision.sourceProjectId === a.id));

  const long = await stage('plantLongCard', async () => {
    // The migration above must create its own directory. Independently exercise the opening even if it failed.
    await sessions.ensureTypeDirectory(id, 'safety_notes');
    const card = await replaceLabFile(lab.parts, user, 'safety_notes/long-card.md', '# 长卡\n' + '保留原始病史的限定范围。'.repeat(180) + '仅在条件 Z-71 成立时。');
    await sessions.setTags(id, card.uri, ['project=' + a.id]);
    await overlay.upsertFile({ userId: id, uri: card.uri, memoryType: 'safety_notes', projectId: a.id });
    return card;
  });
  await stage('plantProfile', () => replaceLabFile(lab.parts, user, 'profile.md', Array.from({ length: 80 }, (_, n) => '- ' + n + ' ' + '个人工作记录。'.repeat(24)).join('\n')));
  report.before = { profile: await stage('profile', () => buildProfileBlock(reader, { pluginTgz: values['plugin-tgz'] })),
    resident: await stage('firstOpening', () => reader.residentBlock()) };
  await check('profile', () => /partial|truncated|elided/i.test(report.before.profile));
  await check('legacyOpening', () => migrated && report.before.resident?.includes(legacy) && report.before.resident.includes(uri) && report.before.resident.includes(migrated.updatedAt));
  await check('freshOpening', () => fresh && report.before.resident?.includes(fresh.body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')));
  await check('pointer', () => long && report.before.resident?.includes(long.uri) && report.before.resident.includes('长卡') && !report.before.resident.includes('Z-71'));
  await check('full', async () => {
    const full = await reader.callTool('read', { uris: [long.uri] });
    return !full.isError && full.blocks.join('').includes('仅在条件 Z-71 成立时');
  });

  // Measure the gateway wall clock separately from aggregate engine request time. Keep routes only.
  report.forgetTiming = {};
  const restore = [];
  function measure(target, method, label) {
    const original = target[method];
    target[method] = async function (...args) {
      const key = label(...args);
      const start = performance.now();
      try { return await original.apply(this, args); }
      finally {
        const row = report.forgetTiming[key] ??= { count: 0, ms: 0 };
        row.count++; row.ms += Math.round(performance.now() - start);
      }
    };
    restore.push(() => { target[method] = original; });
  }
  measure(client, 'request', input => input.path.startsWith('/api/v1/content/') || input.path.startsWith('/api/v1/fs') ? input.path : 'otherEngine');
  measure(lab.parts.history, 'rejectRemoved', () => 'historyReview');
  measure(nativeMemory.rejectionJudge, 'same', () => 'semanticReview');
  let forgotten;
  try { forgotten = await stage('gatewayForget', () => writer.callTool('forget', { uri, lines: [legacy] })); }
  finally { for (const reset of restore) reset(); }
  report.forgetReceipt = forgotten?.blocks.map(block => lab.redact(block));
  await check('forget', () => forgotten && !forgotten.isError && /Removed 1 line\(s\)/.test(forgotten.blocks.join('\n')));
  await check('neighbour', async () => migrated && (await sessions.read(id, uri))?.includes('咖啡')
    && !(await sessions.read(id, uri)).includes('碘海醇') && await sessions.read(id, migrated.uri) === null);
  const cleanCards = async () => {
    const prefix = sessions.memoryRoot(id) + '/safety_notes';
    const files = (await sessions.tree(id, prefix)).filter(node => !node.isDir && node.uri.startsWith(prefix + '/') && node.uri.endsWith('.md'));
    const bodies = await Promise.all(files.map(node => sessions.read(id, node.uri)));
    return bodies.some(text => text?.includes('乳胶')) && bodies.every(text => typeof text === 'string' && !text.includes('碘海醇'));
  };
  const cleanOpening = text => typeof text === 'string' && !text.includes('碘海醇') && text.includes('乳胶');
  await check('cards', cleanCards);
  report.after = { resident: await stage('secondOpening', () => reader.residentBlock()) };
  await check('opening', () => cleanOpening(report.after.resident));
  await new Promise(resolve => setTimeout(resolve, 301000));
  await stage('secondMigration', () => worker.migrateSafety(id));
  report.secondScanAt = await stage('secondScanReceipt', scanInstant);
  await check('retry', async () => {
    const [absent, clean, opening] = await Promise.all([migrated && sessions.read(id, migrated.uri).then(text => text === null),
      cleanCards(), reader.residentBlock()]);
    return Date.parse(report.secondScanAt) - Date.parse(report.firstScanAt) >= 300000 && absent && clean && cleanOpening(opening);
  });
} catch (error) { report.error = errorOf(error); }
finally {
  await check('cleanup', async () => {
    if (!lab) return false;
    report.cleanup = await lab.eraseAccount();
    return ['absent', 'deleted'].includes(report.cleanup.engine) && report.cleanup.users === 1;
  });
  await stage('close', async () => lab?.close());
  for (const [id, name] of checks) if (!report.checks.some(row => row.id === id)) report.checks.push({ id, name, pass: false, blocked: true });
  report.pass = !report.error && report.checks.every(row => row.pass) && report.stages.every(row => row.ok);
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (!report.pass) process.exitCode = 1;
}
