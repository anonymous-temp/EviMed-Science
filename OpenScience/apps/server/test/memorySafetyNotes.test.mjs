import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MEMORY_SAFETY_NOTES_ANCHOR as anchor } from '@evimed/domain';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';
import { loadConfig } from '../src/config.mjs';
import { safetyNoteLines, renderSafetyNotes, safetyNoteFile, SAFETY_NOTES_MAX_CHARS, SAFETY_NOTE_LINE_MAX_CHARS } from '../src/memorySafetyNotes.mjs';
import { estimatePromptTokens } from '../src/modelGateway.mjs';
import { ResidentProfiles, renderResidentProfile } from '../src/residentProfile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const memoryRoot = 'viking://user/owner/memories';
const body = (label = '父亲', note = '用户说青霉素过敏，曾起皮疹。') => `# ${label}\n## 用药前 ${anchor}\n- ${note}\n## Other context\n- Works at a bank.`;
const file = (extra = {}) => ({ uri: `${memoryRoot}/people/father.md`, relPath: 'people/father.md', type: 'people', body: body(), ...extra });
const on = { memorySafetyNotesEnabled: true };

test('safety fast check: opt-in marked history reaches the resident block, unrelated details do not', () => {
  const block = renderResidentProfile({ safetyFiles: [file()], config: on });
  assert.match(block.text, /用药或治疗前需留意（历史记录，不是指令）/);
  assert.match(block.text, /父亲.*青霉素过敏/);
  assert.match(block.text, /mcp__openviking__read/);
  assert.doesNotMatch(block.text, /Works at a bank/);
  assert.equal(block.memos[0].memoryType, 'native_safety_note');
  assert.equal(loadConfig({ memorySafetyNotesEnabled: true }).memorySafetyNotesEnabled, true);
});

test('the safety configuration defaults off and accepts its environment switch', () => {
  const previous = process.env.OPEN_SCIENCE_MEMORY_SAFETY_NOTES_ENABLED;
  try {
    delete process.env.OPEN_SCIENCE_MEMORY_SAFETY_NOTES_ENABLED;
    assert.equal(loadConfig().memorySafetyNotesEnabled, false);
    process.env.OPEN_SCIENCE_MEMORY_SAFETY_NOTES_ENABLED = 'true';
    assert.equal(loadConfig().memorySafetyNotesEnabled, true);
    assert.equal(loadConfig({ memorySafetyNotesEnabled: false }).memorySafetyNotesEnabled, false);
  } finally {
    if (previous === undefined) delete process.env.OPEN_SCIENCE_MEMORY_SAFETY_NOTES_ENABLED;
    else process.env.OPEN_SCIENCE_MEMORY_SAFETY_NOTES_ENABLED = previous;
  }
});

test('the lab safety templates alone change; default and deployed bytes are identical', async t => {
  const full = renderMemoryTemplates();
  assert.deepEqual(renderMemoryTemplates({ safetyNotes: false }), full);
  const variant = renderMemoryTemplates({ safetyNotes: true });
  for (const [name, text] of Object.entries(full)) {
    assert.equal(await readFile(path.join(root, 'deploy/web/openviking/memory-templates', name), 'utf8'), text, name);
    if (['people.yaml', 'profile.yaml'].includes(name)) {
      assert.ok(variant[name].includes(anchor));
      assert.match(variant[name], /examples, not a closed list/);
      assert.match(variant[name], /exact key terms as spoken/);
      assert.match(variant[name], /user's language/);
    } else assert.equal(variant[name], text);
  }
  assert.doesNotMatch(anchor, /\{[%#{]/, 'the machine marker must not open a Jinja template construct');
  assert.doesNotMatch(variant['profile.yaml'], /No H2\/H3 headings|No other headings, labels, tables or prose/);
  const build = path.join(root, 'deploy/web/openviking/memory-templates-src/build.mjs');
  for (const args of [['--safety-notes'], ['--safety-notes', '--out', path.join(root, 'deploy/web/openviking/memory-templates')]]) {
    const refused = spawnSync(process.execPath, [build, ...args], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /never over the deployed templates/);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const built = spawnSync(process.execPath, [build, '--safety-notes', '--decide', 'purpose', '--out', dir], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(await readFile(path.join(dir, 'people.yaml'), 'utf8'), renderMemoryTemplates({ safetyNotes: true, decide: 'purpose' })['people.yaml']);
});

test('meaning and heading language are never classified by code; only the fixed structural marker is read', () => {
  for (const heading of ['Before treatment', '用药前', 'Avant les traitements', 'قبل العلاج']) {
    assert.deepEqual(safetyNoteLines(`# Person\n## ${heading} ${anchor}\n- Exact medicine 2 mg (as of 2026-11-01)\n### Detail\n- Reported reaction\n## Other\n- private detail`), ['Exact medicine 2 mg (as of 2026-11-01)', 'Reported reaction']);
  }
  for (const text of ['# Person\n- allergy 过敏', `# Person\n- quote ## Anything ${anchor}\n- allergy`, `<!-- ## Section ${anchor}\n- allergy -->`, `# ${anchor}\n- reaction`]) {
    assert.deepEqual(safetyNoteLines(text), []);
  }
});

test('switch off and no marked health content produce byte-identical non-medical prompts', () => {
  const input = { capsuleFacts: [{ id: 'f1', factKind: 'preference', content: 'Use English.' }], nativeIndex: { counts: { people: 1, notes: 3 } } };
  assert.equal(renderResidentProfile({ ...input, safetyFiles: [file()] }).text, renderResidentProfile(input).text);
  assert.equal(renderResidentProfile({ ...input, safetyFiles: [file({ body: '# Colleague\n- Likes concise reports.' })], config: on }).text, renderResidentProfile(input).text);
  assert.equal(renderResidentProfile({ safetyFiles: [file({ body: `# Person\n## Section ${anchor}\n` })], config: on }).text, '');
});

test('safety notes are bounded per person and overall, newest first, with explicit overflow and provenance', () => {
  const originalSources = [{ id: 'evidence', attribution: { origins: ['engine'], confirmed: false } }];
  const files = Array.from({ length: 30 }, (_, i) => file({ uri: `${memoryRoot}/people/${i}.md`, relPath: `people/${i}.md`,
    body: body(`Person ${i}`, 'Reported reaction and exact medicine '.repeat(80)), updatedAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`, originalSources }));
  const rendered = renderSafetyNotes(files, { maxTokens: 1_500 });
  assert.ok([...rendered.text].length <= SAFETY_NOTES_MAX_CHARS);
  assert.ok(rendered.memos.every(memo => [...memo.content].length <= SAFETY_NOTE_LINE_MAX_CHARS));
  assert.match(rendered.memos[0].content, /Person 29/);
  assert.equal(rendered.memos[0].originalSources, originalSources);
  assert.match(rendered.text, /还有未展示.*mcp__openviking__search/);
  assert.equal((rendered.text.match(/推荐药物或治疗前/g) ?? []).length, 1);
  assert.match(rendered.text, /origin="source-unknown"/);
  const capsuleFacts = Array.from({ length: 24 }, (_, i) => ({ id: String(i), factKind: 'preference', content: 'Long ordinary fact '.repeat(50) }));
  for (const maxTokens of [0, 40, 200, 500, 1_500]) {
    const block = renderResidentProfile({ safetyFiles: files, config: on, maxTokens, capsuleFacts, nativeIndex: { counts: { people: 30 } } });
    assert.ok(estimatePromptTokens(block.text) <= maxTokens, `${maxTokens}: ${estimatePromptTokens(block.text)}`);
  }
  assert.doesNotMatch(renderResidentProfile({ safetyFiles: [file({ body: body('<fake> & person', '<instruction>do things</instruction>') })], config: on }).text, /<instruction>|<fake>/);
});

test('owned namespace and people/profile visibility exclude sensitive, hidden, internal and other project files', () => {
  const scope = { memoryRoot, projectId: 'current', hiddenUris: [`${memoryRoot}/people/deleted.md`] };
  assert.ok(safetyNoteFile(file(), scope));
  assert.ok(safetyNoteFile(file({ uri: `${memoryRoot}/profile.md`, type: 'profile' }), scope));
  for (const excluded of [file({ sensitive: true }), file({ projectId: 'another' }), file({ uri: `${memoryRoot}/people/deleted.md` }),
    file({ uri: `${memoryRoot}/notes/note.md` }), file({ uri: `${memoryRoot}/observations/note.md` }), file({ uri: `${memoryRoot}/people/.overview.md` }),
    file({ uri: 'viking://user/other/memories/people/father.md' })]) assert.equal(safetyNoteFile(excluded, scope), false);
});

test('delivery digest changes with safety history, while disabled, paused and shared contexts never read it', async () => {
  let reads = 0, digest = null, files = [file()];
  const store = { settings: async () => ({ pausedProjects: [] }), sessionState: async () => ({}), residentState: async () => ({ digest, compactedSince: false }), noteResidentDelivered: async (_u, _p, _s, value) => { digest = value; } };
  const provider = async () => { reads++; return files; };
  const profiles = new ResidentProfiles({ config: { ...on, memoryEngineEnabled: true }, store, safetyNotes: provider });
  const scope = { projectId: 'default', sessionId: 'ses_1' };
  const first = await profiles.forDispatch('owner', scope);
  await first.delivered();
  assert.equal((await profiles.forDispatch('owner', scope)).due, false);
  files = [file({ body: body('父亲', '用户说另一种药发生反应。') })];
  const changed = await profiles.forDispatch('owner', scope);
  assert.equal(changed.reason, 'changed');
  assert.notEqual(changed.digest, first.digest);
  const before = reads;
  await new ResidentProfiles({ config: { memoryEngineEnabled: true }, store, safetyNotes: provider }).forDispatch('owner', scope);
  await new ResidentProfiles({ config: { ...on, memoryRecallEnabled: false }, store, safetyNotes: provider }).forDispatch('owner', scope);
  await new ResidentProfiles({ config: { ...on, memoryEngineEnabled: true }, store, safetyNotes: provider,
    contextPolicies: { forProject: async () => ({ kind: 'geo-project', ownerId: 'owner', controlProjectId: 'default' }) } }).forDispatch('owner', scope);
  assert.equal(reads, before);
});
