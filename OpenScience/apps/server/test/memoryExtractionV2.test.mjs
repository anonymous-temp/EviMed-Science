import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';
import { checkMemoryNoteLabels, memoryHistoryLine } from '../../../packages/domain/src/memoryExtractionFormat.mjs';
import { nativeMemoryFile, observationFile } from '../src/openVikingSessions.mjs';

const release = new URL('../../../deploy/web/openviking/', import.meta.url);
test('default and extraction-v2 rendered artifacts are pinned independently', () => {
  for (const [variant, directory] of [['full', 'memory-templates'], ['extraction-v2', 'memory-templates-extraction-v2']]) {
    const rendered = renderMemoryTemplates({ variant });
    assert.deepEqual(readdirSync(new URL(`${directory}/`, release)).sort(), Object.keys(rendered).sort());
    for (const [name, text] of Object.entries(rendered)) assert.equal(readFileSync(new URL(`${directory}/${name}`, release), 'utf8'), text);
  }
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  for (const text of Object.values(v2)) {
    assert.match(text, /Copy names, numbers with units, dates and identifiers exactly/);
    assert.match(text, /keep, labelled/);
    assert.match(text, /earlier: X \(until YYYY-MM-DD\)/);
  }
  assert.doesNotMatch(v2['observations.yaml'], /no name, no number|No names, numbers/);
  assert.doesNotMatch(v2['preferences.yaml'], /only the current choice|No dates/);
  assert.doesNotMatch(v2['profile.yaml'], /prior states in NOTES|replace a changed state/);
  assert.doesNotMatch(v2['project_context.yaml'], /decision replaces its line|Remove an item once/);
  assert.doesNotMatch(v2['entities.yaml'], /fact that is not contradicted/);
});

test('NOTES format check counts all unlabelled statements without judging their meaning', () => {
  assert.deepEqual(checkMemoryNoteLabels(`# Notes\n- user believes: Quiet streets matter. (recorded 2026-11-01)\n- assistant suggested (declined): RX-7. (recorded 2026-11-02)\n- document says: Report A — 2.5 mg. (recorded 2026-11-03)\n- user stated: Exact sentence. (recorded 2026-11-03)`),
    { checked: 4, missingLabel: 0, malformed: 0, sensitive: false });
  assert.deepEqual(checkMemoryNoteLabels(`# 笔记\n- 用户观点（敏感）：某立场。（记录日期 2026-11-01）\n- 助手建议（未采纳）：RX-7。（记录日期 2026-11-02）\n- 文档声称：报告甲 — 2.5 mg。（记录日期 2026-11-03）\n> 来源变更：标签\n- 任意未标注内容\n无标签的段落\n- assistant suggested: no outcome`),
    { checked: 6, missingLabel: 2, malformed: 1, sensitive: true });
  for (const outcome of ['adopted', 'declined', 'not answered']) assert.equal(checkMemoryNoteLabels(`- assistant suggested (${outcome}): X (recorded 2026-11-01)`).malformed, 0);
  for (const outcome of ['已采纳', '未采纳', '未答复']) assert.equal(checkMemoryNoteLabels(`- 助手建议（${outcome}）：X（记录日期 2026-11-01）`).malformed, 0);
  assert.equal(checkMemoryNoteLabels('- user believes: Missing date').malformed, 1);
  assert.equal(checkMemoryNoteLabels('- Opinion de la personne: [sensitive] Une conviction.').sensitive, true);
  assert.equal(checkMemoryNoteLabels('- 用户陈述：内容含有用户观点（敏感）：但不是前缀（记录日期 2026-11-01）').sensitive, false);
});

test('history wrappers preserve exact values and dates; ordinary prose is not classified', () => {
  assert.deepEqual(memoryHistoryLine('earlier: 阿哌沙班 2.5 mg (until 2026-11-04)'), { value: '阿哌沙班 2.5 mg', until: '2026-11-04', prefix: 'earlier: ', suffix: ' (until 2026-11-04)' });
  assert.equal(memoryHistoryLine('曾为：房租 2800 元（截至 2026-11-04）').value, '房租 2800 元');
  assert.equal(memoryHistoryLine('Earlier today we discussed 2.5 mg'), null);
});

test('recorded conversations pin anchors and NOTES/history formats without pretending to run extraction', () => {
  const directory = new URL('./fixtures/memory-extraction-v2/', import.meta.url);
  for (const name of readdirSync(directory)) {
    const fixture = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
    const transcript = fixture.sessions.flatMap(session => session.messages.map(message => message.text)).join('\n');
    const last = fixture.sessions.at(-1).writes;
    for (const anchor of fixture.anchors) {
      assert.ok(transcript.includes(anchor));
      assert.ok(Object.values(last).some(body => body.includes(anchor)), `${name}: ${anchor}`);
    }
    for (const session of fixture.sessions) for (const [path, body] of Object.entries(session.writes)) {
      const root = 'viking://user/fixture/memories';
      assert.ok(nativeMemoryFile(`${root}/${path}`, root) ?? observationFile(`${root}/${path}`, root), `${name}: unrecognized memory path ${path}`);
      if (path.startsWith('notes/')) {
        assert.equal(checkMemoryNoteLabels(body).missingLabel, 0);
        assert.equal(checkMemoryNoteLabels(body).malformed, 0);
      }
      for (const line of body.split('\n')) if (line.startsWith('- earlier: ')) assert.ok(memoryHistoryLine(line.slice(2)));
    }
  }
});

test('NOTES quality counters report format coverage without content or rewriting', async () => {
  const { recordMemoryNoteLabels, resetNativeMemoryMetrics, nativeMemoryCounters, nativeMemoryMetricFamilies } = await import('../src/nativeMemoryMetrics.mjs');
  resetNativeMemoryMetrics();
  const body = '- user believes: A. (recorded 2026-11-01)\n- Unlabelled B.\n- assistant suggested: C.';
  recordMemoryNoteLabels(checkMemoryNoteLabels(body));
  assert.deepEqual(nativeMemoryCounters().noteLabels, { checked: 3, missing_label: 1, malformed: 1 });
  const family = nativeMemoryMetricFamilies().find(item => item.name === 'open_science_native_memory_note_labels_total');
  assert.deepEqual(family.series.map(item => item.labels.outcome), ['checked', 'missing_label', 'malformed']);
  resetNativeMemoryMetrics();
  assert.equal(nativeMemoryCounters().noteLabels.checked, 0);
});

test('one deployment setting selects the mounted templates and the worker; CLI cannot overwrite the default', async () => {
  const { spawnSync } = await import('node:child_process');
  const build = new URL('../../../deploy/web/openviking/memory-templates-src/build.mjs', import.meta.url);
  for (const args of [['--check'], ['--variant', 'extraction-v2', '--out', new URL('memory-templates-extraction-v2/', release).pathname, '--check']]) {
    const result = spawnSync(process.execPath, [build.pathname, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(process.execPath, [build.pathname, '--variant', 'extraction-v2'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /never over the deployed templates/);
  const compose = readFileSync(new URL('../../../deploy/web/docker-compose.yml', import.meta.url), 'utf8');
  assert.ok(compose.includes('./openviking/${OPEN_SCIENCE_MEMORY_TEMPLATES_DIR:-memory-templates}:/app/memory-templates:ro'));
  assert.ok(compose.includes('OPEN_SCIENCE_MEMORY_TEMPLATES_DIR: ${OPEN_SCIENCE_MEMORY_TEMPLATES_DIR:-memory-templates}'));
  assert.throws(() => renderMemoryTemplates({ variant: 'extraction-v2', pastedRule: 'v1' }), /one complete variant/);
});
