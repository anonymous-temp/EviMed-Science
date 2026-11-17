import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';

test('default state types retain bounded history and never record a forget request as a new event', async () => {
  const templates = renderMemoryTemplates();
  for (const type of ['profile', 'preferences', 'project_context', 'people', 'notes', 'entities', 'decisions', 'follow_ups', 'project_facts']) {
    const body = templates[`${type}.yaml`];
    assert.match(body, /At most the two latest earlier values/);
    assert.match(body, /none for a value removed by a forget request/);
    assert.match(body, /do not add a note that restates the withdrawn/);
    assert.match(body, /label the date unknown, never invent one/);
  }
  for (const [name, body] of Object.entries(templates)) assert.equal(body, await readFile(new URL(`../../../deploy/web/openviking/memory-templates/${name}`, import.meta.url), 'utf8'));
});

test('project stages require stated status while asides, numbers and explicit confirmation remain eligible', () => {
  const templates = renderMemoryTemplates();
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
