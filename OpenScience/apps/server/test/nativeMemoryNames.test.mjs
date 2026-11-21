import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryNameKey, mergeNormalizedMemoryText, normalizedMemoryName, reconcileMemoryNames } from '../src/nativeMemoryNames.mjs';
import { lineFingerprint, memoryLines } from '../src/nativeMemoryOverlay.mjs';
const root = 'viking://user/test/memories';

test('formatting equality retains type, path segments, disambiguating suffixes and spelling differences', () => {
  assert.equal(normalizedMemoryName('ＢＩ－ＲＡＤＳ_4 类'), normalizedMemoryName('bi-rads 4类'));
  assert.equal(memoryNameKey(`${root}/projects/BI-RADS 4 类.md`, root), memoryNameKey(`${root}/projects/bi_rads_4类.md`, root));
  for (const [a, b] of [['projects/a.md', 'people/a.md'], ['people/王青-01.md', 'people/王青-02.md'], ['people/Mary-Ann.md', 'people/mary_ann.md'], ['entities/drug/a.md', 'entities/tool/a.md'], ['entities/drug/恩布格列净.md', 'entities/drug/恩格列净.md']]) {
    assert.notEqual(memoryNameKey(`${root}/${a}`, root), memoryNameKey(`${root}/${b}`, root));
  }
  assert.equal(memoryNameKey('viking://user/other/memories/projects/a.md', root), null);
});

test('merge keeps the current card first and every older specific statement', () => {
  const before = '# BI-RADS\n- PubMed and Embase; 4000 words (as of 2026-03-01)\n- Adult women; blinded review.';
  const after = '# BI_RADS\n- PubMed; 3000 words (as of 2026-04-01)';
  const merged = mergeNormalizedMemoryText(after, before);
  assert.ok(merged.startsWith(after));
  for (const line of memoryLines(before)) assert.ok(merged.includes(line));
  assert.equal(mergeNormalizedMemoryText(merged, before), merged);
});

function fixture({ project = 'p1', sensitive = false, withdrawn = false } = {}) {
  const a = `${root}/projects/BI-RADS 4.md`, b = `${root}/projects/bi_rads_4.md`;
  const before = '# Old\n- Embase; 4000 words (as of 2026-03-01)', after = '# New\n- PubMed; 3000 words (as of 2026-04-01)';
  const bodies = new Map([[a, before], [b, after]]), files = new Map([[a, { body: before, projectId: 'p1', createdAt: '1' }], [b, { body: after, projectId: project, sensitive, createdAt: '2' }]]);
  const origins = new Map([...bodies].map(([uri, body]) => [uri, new Map(memoryLines(body).map(line => [lineFingerprint(line), { archiveUri: `source:${uri}` }]))]));
  const revisions = [];
  const overlay = { queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {}, files: async () => files, file: async (_u, uri) => files.get(uri), removals: async () => [],
    memoryForgetBody: async (_u, uri, body) => withdrawn && uri === b ? null : body,
    originsOf: async () => origins, addRevision: async row => { revisions.push(row); return row; },
    upsertFile: async row => files.set(row.uri, row), inheritOrigins: async (_u, uri, value) => origins.set(uri, value), removeFile: async (_u, uri) => files.delete(uri) };
  const context = { sessions: { memoryRoot: () => root, read: async (_u, uri) => bodies.get(uri) ?? null,
    replace: async (_u, uri, body) => bodies.set(uri, body), remove: async (_u, uri) => bodies.delete(uri), setTags: async () => {}, rebuildMemoryDirectory: async () => {} } };
  return { a, b, before, after, bodies, files, origins, revisions, overlay, context };
}

test('merge preserves ancestry and revisions before retiring a redundant path, and is idempotent', async () => {
  const f = fixture();
  assert.equal(await reconcileMemoryNames({ userId: 'u', ...f }), 1);
  assert.equal(f.bodies.has(f.b), false); assert.ok(f.bodies.get(f.a).startsWith(f.after)); assert.ok(f.bodies.get(f.a).includes('Embase'));
  assert.equal(f.origins.get(f.a).size, 2); assert.equal(f.revisions.length, 2);
  assert.equal(await reconcileMemoryNames({ userId: 'u', ...f }), 0);
});
for (const options of [{ project: 'p2' }, { sensitive: true }, { withdrawn: true }]) test(`merge respects project and withdrawal fences ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  assert.equal(await reconcileMemoryNames({ userId: 'u', ...f }), 0);
  assert.equal(f.bodies.get(f.a), f.before); assert.equal(f.bodies.get(f.b), f.after);
});

test('reconciliation never writes a destination whose name alone is withdrawn', async () => {
  const f = fixture();
  f.overlay.removals = async () => [{ text: 'Project "BI-RADS 4".', fingerprint: 'removed-name' }];
  assert.equal(await reconcileMemoryNames({ userId: 'u', ...f }), 0);
  assert.equal(f.revisions.length, 0);
  assert.equal(f.bodies.get(f.a), f.before);
});
