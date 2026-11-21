// S-A07 uses the product worker, a real extractor, the pinned plugin and the resident opening.
// Run against an already-running local lab. --help reads no credentials or services.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const names = ['base', 'engine-url', 'engine-key-file', 'database-url-file', 'deepseek-key-file', 'plugin-tgz', 'out'];
const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])), help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node evals/capsule-proving/pp/safety-opening.mjs ' + names.map(name => '--' + name + ' <value>').join(' '));
  console.log('Use the same local safety-enabled lab stack for --base and --engine-url. Supply the pinned plugin archive. The report is synthetic. Allow 10 minutes including the real migration cooldown.');
  process.exit(0);
}
for (const name of names) assert.ok(values[name], 'Missing --' + name);
for (const name of ['base', 'engine-url']) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(values[name]).hostname), 'Local lab only');
const { openLab, replaceLabFile } = await import('../run/lab.mjs');
const { buildProfileBlock } = await import('../run/openingBlock.mjs');
const report = { run: 'safe-' + randomUUID(), checks: [], pass: false };
const check = (condition, name) => { assert.ok(condition, name); report.checks.push(name); };
let lab;
try {
  const readiness = await (await fetch(new URL('/api/ready', values.base), { signal: AbortSignal.timeout(30000) })).json();
  const template = readiness?.data?.checks?.memoryIndex?.engine?.facts?.memoryTemplates;
  check(template?.ok && template.types.includes('safety_notes'), 'running control plane verified the safety template and policy');
  lab = await openLab({ engineUrl: values['engine-url'], engineKeyFile: values['engine-key-file'], databaseUrlFile: values['database-url-file'],
    deepseekKeyFile: values['deepseek-key-file'], account: 'evlab-' + report.run, historySearch: false,
    configOverrides: { memorySafetyNotesEnabled: true, memorySafetyNotesMigrationEnabled: true, memoryForgetTargetsEnabled: true } });
  const user = await lab.user('owner'), { sessions, worker, overlay, nativeMemory } = lab.parts;
  check(lab.facts.policyRewritten === 0 && lab.facts.memoryTypes.includes('safety_notes'), 'fresh engine identity already allows safety extraction');
  const a = { id: 'study-a', name: 'First study' }, b = { id: 'study-b', name: 'Second study' };
  const writer = lab.memoryFor(user, { project: a, executeForget: true }), reader = lab.memoryFor(user, { project: b });
  const legacy = '我本人对碘海醇过敏，不能使用碘海醇。';
  const legacyPath = 'people/old-owner.md';
  const { uri } = await replaceLabFile(lab.parts, user, legacyPath, '# 我本人\n- ' + legacy + '\n- 我对咖啡没兴趣。');
  await sessions.setTags(user.userId, uri, ['project=' + a.id]);
  await overlay.upsertFile({ userId: user.userId, uri, memoryType: 'people', projectId: a.id });
  await worker.migrateSafety(user.userId);
  const migrated = (await nativeMemory.safetyNotes(user.userId, b.id)).find(file => file.sourceUri === uri && file.body.includes(legacy));
  check(migrated?.lineHashes.includes(createHash('sha256').update('- ' + legacy).digest('hex')), 'legacy copy points to the exact original file and line');
  check(!migrated.body.includes('咖啡'), 'ordinary preference was not classified as safety history');

  const saidAt = new Date().toISOString();
  const ingested = await lab.ingestSession(user, { sessionId: 'new-fact', project: a, at: saidAt,
    messages: [{ role: 'user', text: '请记住，我本人对乳胶过敏，不能使用乳胶手套。', at: saidAt }] });
  const fresh = (await nativeMemory.safetyNotes(user.userId, b.id)).find(file => file.type === 'safety_notes' && !file.sourceUri && file.body.includes('乳胶'));
  check(fresh?.originalSources.length && fresh.updatedAt && /过敏/.test(fresh.body) && /不能|禁止|避免|不可/.test(fresh.body), 'newly extracted card preserves the negative condition and has a dated receipt');
  const history = await overlay.revisionsOf(user.userId, fresh.uri);
  check(history.some(revision => revision.archiveUri === ingested.commit.archiveUri && revision.engineSession === ingested.engineSession && revision.projectId === a.id), 'new card has the extractor conversation as its source');

  const long = await replaceLabFile(lab.parts, user, 'safety_notes/long-card.md', '# 长卡\n' + '保留原始病史的限定范围。'.repeat(180) + '仅在条件 Z-71 成立时。');
  const longProfile = Array.from({ length: 80 }, (_, n) => '- ' + n + ' ' + '个人工作记录。'.repeat(24)).join('\n');
  await replaceLabFile(lab.parts, user, 'profile.md', longProfile);
  const opening = async () => ({ profile: await buildProfileBlock(reader, { pluginTgz: values['plugin-tgz'] }), resident: await reader.residentBlock() });
  report.before = await opening();
  check(/partial|truncated|elided/i.test(report.before.profile), 'the pinned plugin actually truncated the long profile');
  check(report.before.resident.includes(legacy) && report.before.resident.includes(uri) && report.before.resident.includes(migrated.updatedAt), 'another project receives the complete migrated statement, source and date');
  check(report.before.resident.includes(fresh.body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')), 'another project receives the whole new safety card');
  check(report.before.resident.includes(long.uri) && report.before.resident.includes('长卡') && !report.before.resident.includes('Z-71'), 'oversize card exposes title and a read pointer only');
  const full = await reader.callTool('read', { uris: [long.uri] });
  check(!full.isError && full.blocks.join('').includes('仅在条件 Z-71 成立时'), 'cross-project read resolves the pointer with its final condition');

  const forgotten = await writer.callTool('forget', { uri, lines: [legacy] });
  check(!forgotten.isError && !JSON.stringify(forgotten.blocks).includes('missingLines'), 'the source line was forgotten through the gateway');
  check((await sessions.read(user.userId, uri))?.includes('咖啡') && await sessions.read(user.userId, migrated.uri) === null, 'source neighbour survives and the derived file is gone');
  report.after = await opening();
  check(!report.after.resident.includes('碘海醇') && report.after.resident.includes('乳胶'), 'fresh opening retains only the independent safety history');
  // Observe a second eligible migration, including the source after withdrawal. Do not reset the worker clock.
  await new Promise(resolve => setTimeout(resolve, 301000));
  await worker.migrateSafety(user.userId);
  check(await sessions.read(user.userId, migrated.uri) === null && !(await reader.residentBlock()).includes('碘海醇'), 'eligible retry does not revive the withdrawn statement');
  report.pass = true;
} catch (error) {
  report.error = lab ? lab.redact(error.message) : error.name;
  process.exitCode = 1;
} finally {
  try {
    if (lab) { report.cleanup = await lab.eraseAccount(); assert.ok(['absent','deleted'].includes(report.cleanup.engine)); }
  } catch { report.pass = false; report.cleanupFailed = true; process.exitCode = 1; }
  finally { await lab?.close(); await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
}
