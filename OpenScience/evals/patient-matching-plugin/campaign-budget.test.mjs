import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCampaignBudget } from './campaign-budget.mjs';
test('concurrent providers share a ceiling; uncertain and crashed requests retain their full bound', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-budget-'));
  try {
    const config = { path: path.join(dir, 'budget.json'), limitCny: 5 };
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => createCampaignBudget(config).reserve({ id: `request-${index}`, provider: index % 2 ? 'bailian' : 'deepseek', maxCostCny: 1 })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
    const budget = createCampaignBudget(config), snapshot = await budget.snapshot();
    assert.equal(snapshot.committedCny, 5);
    const [first, second] = snapshot.entries;
    await budget.settle({ id: first.id, costCny: 0.1, uncertain: true });
    assert.equal((await budget.snapshot()).committedCny, 5);
    await budget.settle({ id: second.id, costCny: 0 });
    assert.equal((await budget.snapshot()).committedCny, 4);
    await assert.rejects(budget.reserve({ id: first.id, provider: 'deepseek', maxCostCny: 0.1 }), /already_reserved/);
    await createCampaignBudget(config).reserve({ id: 'resume', provider: 'jev', maxCostCny: 1 });
    await assert.rejects(budget.reserve({ id: 'over', provider: 'deepseek', maxCostCny: 0.01 }), /exhausted/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('missing or truncated durable history cannot reset a restarted campaign ceiling', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-budget-history-'));
  try {
    const filename = path.join(dir, 'budget.json'), options = { path: filename, limitCny: 5 };
    await createCampaignBudget(options).reserve({ id: 'paid', provider: 'deepseek', maxCostCny: 4 });
    const journal = filename + '.journal.jsonl', history = await fs.readFile(journal);
    await fs.unlink(journal);
    await assert.rejects(createCampaignBudget(options).reserve({ id: 'reset', provider: 'deepseek', maxCostCny: 4 }), /journal_missing/);
    await fs.writeFile(journal, history.subarray(0, history.length - 1));
    await assert.rejects(createCampaignBudget(options).reserve({ id: 'reset2', provider: 'deepseek', maxCostCny: 4 }), /journal_truncated/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('a measured overrun is persisted and permanently closes new spending', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-budget-overrun-'));
  try {
    const budget = createCampaignBudget({ path: path.join(dir, 'budget.json'), limitCny: 5 });
    await budget.reserve({ id: 'a', provider: 'deepseek', maxCostCny: 2 });
    await budget.reserve({ id: 'b', provider: 'bailian', maxCostCny: 2 });
    await budget.settle({ id: 'a', costCny: 4 });
    assert.equal((await budget.snapshot()).committedCny, 6);
    assert.equal((await budget.snapshot()).overrun, true);
    await assert.rejects(budget.reserve({ id: 'c', provider: 'jev', maxCostCny: 1 }), /exhausted/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('journal replay preserves legacy seeds, writes a compact header and fails closed on an interrupted append', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-budget-journal-'));
  try {
    const filename = path.join(dir, 'budget.json');
    await fs.writeFile(filename, JSON.stringify({ schemaVersion: 1, limitCny: 5, entries: [{ id: 'seed', provider: 'deepseek', maxCostCny: 1, costCny: 0.2, state: 'settled', uncertain: false }] }));
    const budget = createCampaignBudget({ path: filename, limitCny: 5 });
    assert.equal((await budget.snapshot()).committedCny, 0.2);
    assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).entries, undefined);
    await budget.reserve({ id: 'new', provider: 'bailian', maxCostCny: 1 });
    const restarted = createCampaignBudget({ path: filename, limitCny: 5 });
    assert.equal((await restarted.snapshot()).committedCny, 1.2);
    await fs.appendFile(filename + '.journal.jsonl', '{');
    await assert.rejects(restarted.reserve({ id: 'after-crash', provider: 'deepseek', maxCostCny: 1 }), /journal_interrupted/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
