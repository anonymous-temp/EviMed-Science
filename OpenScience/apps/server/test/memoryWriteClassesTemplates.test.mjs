import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';

test('opt-in next state types retain bounded history and never record a forget request as a new event', async () => {
  const templates = renderMemoryTemplates({ variant: 'next' });
  for (const type of ['profile', 'preferences', 'project_context', 'people', 'notes', 'entities', 'decisions', 'follow_ups', 'project_facts']) {
    const body = templates[`${type}.yaml`];
    assert.match(body, /At most the two latest earlier values/);
    assert.match(body, /none for a value removed by a forget request/);
    assert.match(body, /do not add a note that restates the withdrawn/);
    assert.match(body, /label the date unknown, never invent one/);
  }
  for (const [name, body] of Object.entries(templates)) assert.equal(body, await readFile(new URL(`../../../deploy/web/openviking/memory-templates-next/${name}`, import.meta.url), 'utf8'));
});

test('project stages require stated status while asides, numbers and explicit confirmation remain eligible', () => {
  const templates = renderMemoryTemplates({ variant: 'next' });
  assert.match(templates['project_context.yaml'], /An opinion about difficulty is not a stage/);
  assert.match(templates['project_context.yaml'], /in passing or in a subordinate clause still updates this project/);
  assert.match(templates['notes.yaml'], /number, model name, cost, household detail or project status/);
  assert.match(templates['notes.yaml'], /their corrections and explicit confirmation/);
  assert.match(templates['preferences.yaml'], /Do not add an exception, permission to ask, or scope the user never stated/);
});

test('the optional variant still renders separately, with one history rule per state type', async () => {
  for (const [name, body] of Object.entries(renderMemoryTemplates({ variant: 'extraction-v2' }))) {
    assert.equal(body, await readFile(new URL(`../../../deploy/web/openviking/memory-templates-extraction-v2/${name}`, import.meta.url), 'utf8'));
    assert.ok(body.split('At most the two latest earlier values').length <= 2);
  }
});


test('production defaults do not contain the unapproved next rules', () => {
  for (const body of Object.values(renderMemoryTemplates())) {
    for (const rule of ['At most the two latest earlier values', 'do not add a note that restates the withdrawn',
      'An opinion about difficulty is not a stage', 'number, model name, cost, household detail or project status',
      'Do not add an exception, permission to ask, or scope the user never stated', 'exact fallback heading specified above']) {
      assert.ok(!body.includes(rule), rule);
    }
  }
});

test('every next type requires first-person evidence per clause, including the fallback type', () => {
  for (const text of Object.values(renderMemoryTemplates({ variant: 'next' }))) {
    assert.match(text, /exact words in a user message that support each clause/);
    assert.match(text, /source conversation only, including for NOTES/);
    assert.doesNotMatch(text, /Worthwhile unconfirmed advice is written|may be retained separately in NOTES|may be retained with explicit attribution/);
  }
});

test('only next separates the profile name from a preferred form of address', () => {
  const next = renderMemoryTemplates({ variant: 'next' })['profile.yaml'];
  assert.match(next, /keep "# 林舟" and add "- 希望被称呼为：小林 \(as of 2026-11-21\)"/);
  assert.match(next, /Keep the existing name in the H1 unless the user explicitly corrects or changes their name/);
  assert.match(next, /use the fallback H1 and the separate bullet/);
  for (const options of [{}, { variant: 'extraction-v2' }, { safetyNotes: true }]) {
    assert.doesNotMatch(renderMemoryTemplates(options)['profile.yaml'], /Preferred form of address: Jo/);
  }
});
