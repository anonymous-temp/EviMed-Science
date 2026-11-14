import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';
import { ALIAS_RULE, HISTORY_RULE, OBSERVATION_CHOICE_RULE, OPINION_RULE, STATED_CHOICE_RULE, SUGGESTION_RULE } from '../../../deploy/web/openviking/memory-templates-src/extraction-v2.mjs';
import { checkMemoryNoteLabels, memoryHistoryLine } from '../../../packages/domain/src/memoryExtractionFormat.mjs';
import { MEMORY_DECIDE_EXTRACTION_V2_TEXT, MEMORY_DECIDE_TEXT } from '../../../packages/domain/src/memoryNeverKept.mjs';
import { nativeMemoryFile, observationFile } from '../src/openVikingSessions.mjs';
import { choiceRows, confirmedAliasRequest, confirmedAliases, personLabel } from '../src/nativeMemoryInduction.mjs';

const release = new URL('../../../deploy/web/openviking/', import.meta.url);
const SHARED = 'A personal fact, number, name, date or opinion said in passing inside an unrelated request is extracted like any other statement. Copy names, numbers with units, dates and model numbers as the user wrote them, without reformatting (no added spaces; "3月18日" stays "3月18日").';
const HISTORY_TYPES = ['profile.yaml', 'preferences.yaml', 'project_context.yaml', 'entities.yaml'];
/** The machine-read line rules kept from v2 and the types that carry each. */
const LINE_RULES = /** @type {[string, string[]][]} */ ([[OBSERVATION_CHOICE_RULE, ['observations.yaml']],
  [STATED_CHOICE_RULE, ['preferences.yaml', 'corrections.yaml']], [ALIAS_RULE, ['people.yaml']]]);
const unindent = (/** @type {string} */ text) => text.split('\n').map(line => line.replace(/^ {2}/, '')).join('\n');
/** The example lines of a rule as the model would write them. @param {string} rule @param {string} prefix */
const exampleLines = (rule, prefix) => rule.split('\n').filter(line => line.startsWith(prefix));
const count = (/** @type {string} */ text, /** @type {string} */ part) => text.split(part).length - 1;

test('default and extraction-v2 rendered artifacts are pinned independently', () => {
  for (const [variant, directory] of [['full', 'memory-templates'], ['extraction-v2', 'memory-templates-extraction-v2']]) {
    const rendered = renderMemoryTemplates({ variant });
    assert.deepEqual(readdirSync(new URL(`${directory}/`, release)).sort(), Object.keys(rendered).sort());
    for (const [name, text] of Object.entries(rendered)) assert.equal(readFileSync(new URL(`${directory}/${name}`, release), 'utf8'), text);
  }
});

test('extraction-v2.1 is the default text plus the five additions, each in its types with exact labels', () => {
  const defaults = renderMemoryTemplates();
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  assert.ok(MEMORY_DECIDE_EXTRACTION_V2_TEXT.startsWith(`${MEMORY_DECIDE_TEXT}\n`), 'the default decide text is carried unchanged');
  assert.equal(MEMORY_DECIDE_EXTRACTION_V2_TEXT, `${MEMORY_DECIDE_TEXT}\n${SHARED}`);
  for (const [name, text] of Object.entries(v2)) {
    // Rules 4 (asides) and 5 (exactness): once in the shared block of every type, never in the default.
    assert.equal(count(text, SHARED), 1, name);
    assert.equal(count(defaults[name], SHARED), 0, name);
    // Rule 1 (changed values): only in the four types whose default text replaced or dropped the earlier value.
    assert.equal(count(text, HISTORY_RULE), HISTORY_TYPES.includes(name) ? 1 : 0, name);
    // Rules 2 and 3 (opinions, unadopted suggestions): stated with their labels in NOTES only.
    assert.equal(count(text, OPINION_RULE), name === 'notes.yaml' ? 1 : 0, name);
    assert.equal(count(text, SUGGESTION_RULE), name === 'notes.yaml' ? 1 : 0, name);
    for (const rule of [HISTORY_RULE, OPINION_RULE, SUGGESTION_RULE]) assert.ok(!defaults[name].includes(rule), name);
    // The machine-read line formats kept from v2 are each in their own types only, never in the default.
    for (const [rule, types] of LINE_RULES) {
      assert.equal(count(unindent(text), rule), types.includes(name) ? 1 : 0, name);
      assert.ok(!unindent(defaults[name]).includes(rule), name);
    }
    // No other wording of the earlier, broader v2 is carried over.
    assert.doesNotMatch(text, /extraction-v2 line protocol|Source labels apply in every memory type|用户观点|助手建议（未答复）|（记录日期|Inferred from behaviour|Withdrawn inference|sensitive\)/, name);
  }
  assert.ok(HISTORY_RULE.includes('"曾为：<earlier value>（截至 YYYY-MM-DD）" in Chinese, otherwise "earlier: <earlier value> (until YYYY-MM-DD)"'));
  assert.match(HISTORY_RULE, /At most the two latest earlier values per item; none for a value removed by a forget request\./);
  assert.ok(OPINION_RULE.includes('a line starting "用户认为：" ("User believes:" in English) with its date'));
  assert.match(OPINION_RULE, /never a preference rule, decision, project-card line or writing rule/);
  assert.ok(SUGGESTION_RULE.includes('a line starting "助手建议（用户未采用）：" ("Assistant suggested (not adopted):") with its date, at most two per conversation'));
  assert.match(SUGGESTION_RULE, /never a preference or decision until the user adopts it in words; explanations, glosses and restatements are not kept/);
  // The types an opinion or a suggestion must never become say so at their point of use.
  assert.match(v2['preferences.yaml'], /attributed opinions belong in NOTES\. An opinion \("我觉得…"\) or an unadopted assistant suggestion is never a preference or a writing rule for a topic\./);
  assert.match(v2['decisions.yaml'], /never a view the user voices \(NOTES, "用户认为："\)/);
  assert.match(v2['project_context.yaml'], /a view the user voices goes to NOTES \("用户认为："\), never onto the card/);
  // The three types that carry none of the type-local rules are the default text with only the shared sentence added.
  const decideEnd = MEMORY_DECIDE_TEXT.split('\n').at(-1);
  for (const name of ['follow_ups.yaml', 'project_facts.yaml', 'recent_work.yaml']) {
    assert.equal(v2[name], defaults[name].replace(decideEnd, () => `${decideEnd}\n  ${SHARED}`), name);
  }
});

test('extraction-v2.1 removes the per-type "replace" rules that contradict a dated earlier value; the default keeps them', () => {
  const defaults = renderMemoryTemplates();
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  /** @type {[string, RegExp][]} */
  const contradictions = [
    ['profile.yaml', /replace the old bullet|prior states in NOTES|replace a changed state|Every bullet ends with the date/],
    ['preferences.yaml', /only the current choice|No dates, events or plans/],
    ['project_context.yaml', /decision replaces its line|Remove an item once/],
  ];
  for (const [name, pattern] of contradictions) {
    assert.match(defaults[name], pattern, `${name}: the default still states it`);
    assert.doesNotMatch(v2[name], pattern, name);
  }
  assert.match(v2['profile.yaml'], /Every current bullet ends with the date/);
  assert.match(v2['profile.yaml'], /labels \(except 曾为 \/ earlier\)/);
  assert.match(v2['preferences.yaml'], /No dates \(except earlier-value bullets\), events or plans\./);
  assert.match(v2['project_context.yaml'], /decision: the new choice is the current line, its earlier value kept as stated below\./);
  assert.match(v2['project_context.yaml'], /Remove an open item once the user says it is done\./);
  // The two wrappers the rule asks for are exactly what the readers treat as history.
  const filled = (/** @type {string} */ wrapper) => wrapper.replace('<earlier value>', '住在迎泽区').replace('YYYY-MM-DD', '2026-03-01');
  for (const wrapper of HISTORY_RULE.match(/"(曾为：[^"]+|earlier: [^"]+)"/g) ?? []) {
    const history = memoryHistoryLine(filled(wrapper.slice(1, -1)));
    assert.ok(history, wrapper);
    assert.equal(history.value, '住在迎泽区');
    assert.equal(history.until, '2026-03-01');
  }
  assert.equal((HISTORY_RULE.match(/"(曾为：[^"]+|earlier: [^"]+)"/g) ?? []).length, 2);
});

test('extraction-v2.1 stays small: at most 13 % more characters per type (15 % for observations and people) and 8 % in total', () => {
  const defaults = renderMemoryTemplates();
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  const length = (/** @type {string} */ text) => [...text].length;
  let before = 0, after = 0;
  for (const [name, text] of Object.entries(defaults)) {
    before += length(text);
    after += length(v2[name]);
    const bound = ['observations.yaml', 'people.yaml'].includes(name) ? 1.15 : 1.13;
    assert.ok(length(v2[name]) <= length(text) * bound, `${name}: ${length(text)} -> ${length(v2[name])}`);
  }
  assert.ok(after <= before * 1.08, `${before} -> ${after}`);
});

test('observation induction parses the Choice line the observations rule asks for (nativeMemoryInduction.mjs choiceRows)', () => {
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  const [example] = exampleLines(OBSERVATION_CHOICE_RULE, '- Choice: ');
  assert.ok(unindent(v2['observations.yaml']).includes(`\n${example}\n`), 'the example is a line of its own in the rendered type');
  assert.deepEqual(choiceRows(example), [{ kind: 'format', scope: '月度汇总', choice: '折线图', subject: 'work' }]);
  // A line written per the rule for another conversation: every kind the rule names is one the reader accepts.
  const kinds = /kind: ([^;]+);/.exec(OBSERVATION_CHOICE_RULE)?.[1].replace(' or ', ', ').split(', ') ?? [];
  assert.deepEqual(kinds, ['form', 'structure', 'tool', 'format', 'length', 'method']);
  for (const kind of kinds) {
    const line = `- Choice: ${JSON.stringify({ kind, scope: '周报', choice: '140字以内', subject: 'work' })}`;
    assert.equal(choiceRows(`# 周报 · 140字以内\n${line}\n${line}`).length, 2, kind);
  }
  // "nothing after the JSON" is what the reader needs: a trailing date or full stop makes the line unreadable.
  assert.deepEqual(choiceRows(`${example}（2026-11-14）`), []);
  assert.deepEqual(choiceRows(`${example}.`), []);
});

test('the stated-choice line in preferences and corrections reaches choiceRows through the worker and store transform', () => {
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  const [example] = exampleLines(STATED_CHOICE_RULE, '- Stated choice: ');
  for (const name of ['preferences.yaml', 'corrections.yaml']) assert.ok(unindent(v2[name]).includes(`\n${example}\n`), name);
  // nativeMemoryWorker.mjs (induction withdrawal) and nativeMemoryStore.mjs (keepRepeatedChoice) both read stated choices this way.
  const transform = ".split('\\n').filter(line => /^\\s*- Stated choice: /.test(line)).join('\\n').replace(/^\\s*- Stated choice: /gm, '- Choice: ')";
  for (const file of ['nativeMemoryWorker.mjs', 'nativeMemoryStore.mjs']) {
    assert.ok(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').includes(transform), file);
  }
  const stated = (/** @type {string} */ body) => choiceRows(body.split('\n').filter(line => /^\s*- Stated choice: /.test(line)).join('\n').replace(/^\s*- Stated choice: /gm, '- Choice: '));
  assert.deepEqual(stated(`# 结果表格式\n- 结果表一律导出为 CSV。\n${example}`), [{ kind: 'format', scope: '结果表', choice: 'CSV', subject: 'work' }]);
});

test('the alias marker pair the people rule asks for is what the alias readers accept (confirmedAliases, confirmedAliasRequest)', () => {
  const v2 = renderMemoryTemplates({ variant: 'extraction-v2' });
  assert.ok(unindent(v2['people.yaml']).includes(ALIAS_RULE));
  assert.match(v2['people.yaml'], /Merge only when the conversation explicitly identifies the same\n {2}person; a shared name, diagnosis, role or similar story is not evidence of shared identity\.\n {2}When the user explicitly says/);
  const sentence = '王阿姨和小王阿姨其实是同一个人';
  const filled = ALIAS_RULE.split('\n').filter(line => line.startsWith('- '))
    .map(line => line.replace("<this card's label>", '王阿姨').replace('<the other label>', '小王阿姨')
      .replace('"<the user\'s verbatim sentence naming both labels>"', JSON.stringify(sentence)));
  assert.equal(filled.length, 2);
  const body = `# 王阿姨\n- 每天早上散步\n${filled.join('\n')}`;
  assert.deepEqual(confirmedAliases(body), ['王阿姨', '小王阿姨']);
  assert.ok(confirmedAliases(body).includes(personLabel('viking://user/u/memories/people/王阿姨.md', body)), 'this card\'s label is the title the merge requires');
  assert.deepEqual(confirmedAliasRequest(body, [{ role: 'user', text: `对了，${sentence}。` }]), ['王阿姨', '小王阿姨']);
  assert.deepEqual(confirmedAliasRequest(body, [{ role: 'assistant', text: sentence }]), []);
});

test('NOTES format check counts labelled statements without judging their meaning; an unlabelled line is not an error', () => {
  assert.deepEqual(checkMemoryNoteLabels(`# Notes\n- user believes: Quiet streets matter. (recorded 2026-11-01)\n- assistant suggested (declined): RX-7. (recorded 2026-11-02)\n- document says: Report A — 2.5 mg. (recorded 2026-11-03)\n- user stated: Exact sentence. (recorded 2026-11-03)`),
    { checked: 4, labelled: 4, malformed: 0, sensitive: false });
  assert.deepEqual(checkMemoryNoteLabels(`# 笔记\n- 用户观点（敏感）：某立场。（记录日期 2026-11-01）\n- 助手建议（未采纳）：RX-7。（记录日期 2026-11-02）\n- 文档声称：报告甲 — 2.5 mg。（记录日期 2026-11-03）\n> 来源变更：标签\n- 任意未标注内容\n无标签的段落\n- assistant suggested: no outcome`),
    { checked: 6, labelled: 3, malformed: 1, sensitive: true });
  for (const outcome of ['adopted', 'declined', 'not answered']) assert.equal(checkMemoryNoteLabels(`- assistant suggested (${outcome}): X (recorded 2026-11-01)`).malformed, 0);
  for (const outcome of ['已采纳', '未采纳', '未答复']) assert.equal(checkMemoryNoteLabels(`- 助手建议（${outcome}）：X（记录日期 2026-11-01）`).malformed, 0);
  assert.equal(checkMemoryNoteLabels('- user believes: Missing date').malformed, 1);
  assert.equal(checkMemoryNoteLabels('- Opinion de la personne: [sensitive] Une conviction.').sensitive, true);
  assert.equal(checkMemoryNoteLabels('- 用户陈述：内容含有用户观点（敏感）：但不是前缀（记录日期 2026-11-01）').sensitive, false);
});

test('the v2.1 NOTES labels count as labelled with any date form; a misplaced or empty v2.1 label is malformed', () => {
  // The labels exactly as the NOTES rules state them.
  const labels = [...`${OPINION_RULE} ${SUGGESTION_RULE}`.matchAll(/"((?:用户认为|User believes|助手建议（用户未采用）|Assistant suggested \(not adopted\))[:：])"/g)].map(match => match[1]);
  assert.deepEqual(labels, ['用户认为：', 'User believes:', '助手建议（用户未采用）：', 'Assistant suggested (not adopted):']);
  const body = ['# 观点与建议', ...labels.map(label => `- ${label}老城区更适合步行（2026-11-01）`), '- 普通笔记，没有标签',
    '- 用户认为（2026-11-01）：日期放在标签里', '- 用户认为：', '- 我觉得这不是标签'].join('\n');
  assert.deepEqual(checkMemoryNoteLabels(body), { checked: 8, labelled: 4, malformed: 2, sensitive: false });
  assert.deepEqual(checkMemoryNoteLabels('- Unlabelled fact one.\n- Unlabelled fact two.'), { checked: 2, labelled: 0, malformed: 0, sensitive: false });
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
        assert.equal(checkMemoryNoteLabels(body).labelled, checkMemoryNoteLabels(body).checked);
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
  assert.deepEqual(nativeMemoryCounters().noteLabels, { checked: 3, labelled: 1, malformed: 1 });
  const family = nativeMemoryMetricFamilies().find(item => item.name === 'open_science_native_memory_note_labels_total');
  assert.deepEqual(family.series.map(item => item.labels.outcome), ['checked', 'labelled', 'malformed']);
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
