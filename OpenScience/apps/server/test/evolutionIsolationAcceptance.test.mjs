import test from 'node:test';
import assert from 'node:assert/strict';
import { completedOutputs, sourceToolResult, isTargetBody, captureFullTextBody, toolErrorCodes } from '../../../scripts/ops/evolution-isolation-acceptance.mjs';

test('live probe parses actual MCP status and both socket envelopes', () => {
  const data = { text: 'PRISMA systematic reviews '.repeat(100) };
  for (const output of [JSON.stringify({ status: 'ok', data, artifacts: [] }), { status: 'success', data }, JSON.stringify({ ok: true, data }), `ok\n${JSON.stringify(data)}`, { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', data }) }] }]) {
    const actual = sourceToolResult(output);
    assert.equal(actual.ok, true);
    assert.deepEqual(actual.data, data);
  }
  assert.equal(sourceToolResult({ status: 'error', data }).ok, false);
  assert.equal(sourceToolResult('PRISMA systematic reviews'), null);
});

test('live probe accepts only completed tool outputs, never source text in prompts', () => {
  const transcript = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'PRISMA systematic reviews' }] }, { role: 'assistant', parts: [
    { type: 'tool', tool: 'web_read', status: 'completed', output: JSON.stringify({ status: 'ok', data: { text: 'actual body' } }) },
    { type: 'tool', tool: 'web_search', status: 'completed', output: 'ok\n{"hits":[]}' },
    { type: 'tool', tool: 'web_read', status: 'running', output: 'ok\n{}' },
  ] }] };
  const outputs = completedOutputs(transcript);
  assert.deepEqual(outputs.map(row => row.tool), ['web_read', 'web_search']);
  assert.equal(outputs[0].result.data.text, 'actual body');
});


test('real XML refusal and partial warning envelopes are diagnosed without treating metadata as retrieved body', () => {
  const refused = sourceToolResult('Error: {"status":"error","summary":"The page is application/xml","data":{}}');
  assert.equal(refused.ok, false);
  const warning = sourceToolResult({ status: 'warning', data: { contentLevel: 'full_text_xml', markdownPath: 'source/fulltext.md' } });
  assert.equal(warning.ok, true);
  assert.equal(isTargetBody(JSON.stringify({ title: 'PRISMA systematic reviews', abstract: 'metadata'.repeat(300) })), false);
  assert.equal(isTargetBody('PRISMA systematic reviews Introduction checking your browser '.repeat(100)), false);
  assert.equal(isTargetBody('PRISMA systematic reviews Introduction Methods Discussion '.repeat(100)), true);
});


test('full-text capture binds actual managed bytes to tool hash and rejects modification or abstract-only metadata', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'source-body-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const text = 'PRISMA systematic reviews Introduction Methods Discussion '.repeat(100);
  await fs.writeFile(path.join(workspace, 'fulltext.md'), text);
  const digest = createHash('sha256').update(text).digest('hex');
  const result = { data: { pmcid: 'PMC8005924', contentLevel: 'full_text_xml', markdownPath: 'fulltext.md', artifactSha256s: { 'fulltext.md': digest } } };
  const body = await captureFullTextBody({ workspaceDir: workspace }, result);
  assert.equal(body.body, text); assert.equal(body.sourceHash, digest);
  assert.equal(await captureFullTextBody({ workspaceDir: workspace }, { data: { ...result.data, contentLevel: 'abstract' } }), null);
  await fs.writeFile(path.join(workspace, 'fulltext.md'), text + 'changed');
  await assert.rejects(captureFullTextBody({ workspaceDir: workspace }, result), /bytes changed/);
});

test('a blocked control that got no exclusion event says what its source tools were told instead', () => {
  // The shapes of the 2026-10-05 blocked control's transcript: a gateway refusal by name, an upstream error, a success.
  const refused = 'Error: {"status":"error","summary":"The public-source gateway is temporarily unavailable.","error":{"code":"evaluation_policy_unreadable","retryable":true}}';
  const transcript = { messages: [{ role: 'assistant', parts: [
    { type: 'tool', tool: 'mcp__evimed__web_read', status: 'completed', output: refused },
    { type: 'tool', tool: 'mcp__evimed__web_read', status: 'completed', output: refused },
    { type: 'tool', tool: 'mcp__evimed__open_access_full_text', status: 'completed', output: 'Error: {"status":"error","summary":"Europe PMC answered with an error (HTTP 503)."}' },
    { type: 'tool', tool: 'mcp__evimed__web_search', status: 'completed', output: JSON.stringify({ status: 'ok', data: { hits: [] } }) },
  ] }] };
  assert.deepEqual(toolErrorCodes(completedOutputs(transcript)), { evaluation_policy_unreadable: 2, uncoded: 1 });
});
