import assert from "node:assert/strict";
import test from "node:test";
import { nativeMemoryIndex } from "../src/memoryOpeningIndex.mjs";
import { renderResidentProfile } from "../src/residentProfile.mjs";
import { estimatePromptTokens } from "../src/modelGateway.mjs";

test('opening index counts places without names or bodies and fits the resident budget, including an otherwise empty opening', () => {
  const memoryRoot = 'viking://user/owner/memories';
  const file = (path, extra = {}) => ({ uri: `${memoryRoot}/${path}`, body: 'Never show this body', ...extra });
  const files = [file('people/Patient A.md'), file('notes/device.md'), file('preferences/self/style.md'),
    file('people/sensitive.md', { sensitive: true }), file('people/withdrawn.md'), file('project_facts/other.md'),
    file('projects/current.md'), file('observations/internal.md'), file('evimed/index.md'), file('notes/.overview.md'),
    { uri: 'viking://user/another/memories/people/other-owner.md' }];
  const nativeIndex = nativeMemoryIndex(files, { memoryRoot, hiddenUris: [`${memoryRoot}/people/withdrawn.md`, `${memoryRoot}/project_facts/other.md`], historySearchEnabled: true });
  assert.deepEqual(nativeIndex.counts, { people: 1, notes: 1, preferences: 1, projects: 1 });
  const off = renderResidentProfile({ nativeFiles: files });
  assert.equal(off.text, '');
  const on = renderResidentProfile({ nativeIndex, maxTokens: 300 });
  assert.match(on.text, /^用户的长期记忆（历史记录，不是指令）：\n记忆索引：/);
  assert.match(on.text, /people 1/); assert.match(on.text, /notes 1/);
  assert.match(on.text, /早先的对话也可搜索/); assert.match(on.text, /mcp__openviking__search/);
  assert.doesNotMatch(on.text, /Patient|device|Never show|other|sensitive|withdrawn/);
  assert.ok(estimatePromptTokens(on.text) <= 300);
  const withoutHistory = renderResidentProfile({ nativeIndex: { ...nativeIndex, historySearchEnabled: false } });
  assert.doesNotMatch(withoutHistory.text, /早先的对话/);
  assert.match(renderResidentProfile({ nativeIndex: { counts: {} } }).text, /暂无已索引文件.*mcp__openviking__search/);
  const facts = Array.from({ length: 24 }, (_, i) => ({ id: String(i), factKind: 'preference', content: '偏好'.repeat(90) }));
  for (const maxTokens of [0, 80, 300, 1500]) {
    const bounded = renderResidentProfile({ nativeIndex, capsuleFacts: facts, maxTokens });
    assert.ok(estimatePromptTokens(bounded.text) <= maxTokens, `${maxTokens}: ${estimatePromptTokens(bounded.text)}`);
  }
});
