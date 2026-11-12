/** Shared lifetime reservation fence. Provider billing remains in the durable UsageLedger. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const units = value => {
  const integer = Math.round(Number(value) * 1e8);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(integer)) throw new TypeError('Invalid campaign amount');
  return integer;
};
const failure = code => Object.assign(new Error(code), { code });
/** Append-only event journal plus incremental replay avoids rewriting 40,000 completed requests per call. */
export function createCampaignBudget({ path: filename, limitCny = 500 }) {
  const limit = units(limitCny), lock = `${filename}.lock`, journal = `${filename}.journal.jsonl`;
  if (!limit) throw new TypeError('A positive campaign ceiling is required');
  const entries = new Map();
  let offset = 0, committed = 0, overrun = false;
  const exposure = row => units(row.uncertain || row.state === 'reserved' ? row.maxCostCny : row.costCny);
  function apply(event) {
    const prior = entries.get(event.id);
    if (event.kind === 'reserve') {
      if (prior) throw failure('campaign_journal_duplicate_request');
      entries.set(event.id, event.row); committed += exposure(event.row);
    } else if (event.kind === 'settle') {
      if (!prior || prior.state !== 'reserved') throw failure('campaign_journal_reservation_invalid');
      committed -= exposure(prior); entries.set(event.id, event.row); committed += exposure(event.row);
    } else throw failure('campaign_journal_event_invalid');
    overrun ||= committed > limit;
  }
  async function replay(minimumBytes = 0, historyRequired = false) {
    let handle;
    try {
      handle = await fs.open(journal, 'r'); const stat = await handle.stat();
      if (stat.size < offset || stat.size < minimumBytes) throw failure('campaign_journal_truncated');
      if (stat.size === offset) return;
      const bytes = Buffer.alloc(stat.size - offset); let read = 0;
      while (read < bytes.length) { const part = await handle.read(bytes, read, bytes.length - read, offset + read); if (!part.bytesRead) throw failure('campaign_journal_read_incomplete'); read += part.bytesRead; }
      const text = bytes.toString('utf8'); if (!text.endsWith('\n')) throw failure('campaign_journal_interrupted');
      for (const line of text.trimEnd().split('\n')) apply(JSON.parse(line));
      offset = stat.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; if (historyRequired) throw failure('campaign_journal_missing'); }
    finally { await handle?.close(); }
  }
  async function append(event) {
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    const handle = await fs.open(journal, 'a', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    apply(event); offset += bytes.length;
  }
  async function change(update) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw failure('campaign_budget_locked'); await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    try {
      let state;
      try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { schemaVersion: 2, limitCny }; }
      if (![1, 2].includes(state.schemaVersion) || units(state.limitCny) !== limit) throw failure('campaign_budget_identity_changed');
      if (state.schemaVersion === 1) {
        // One-time migration is under the same lock. Build a complete journal atomically before publishing version 2.
        try { await fs.access(journal); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const rows = [];
          for (const row of state.entries) {
            const reserved = { ...row, state: 'reserved', uncertain: false }; delete reserved.costCny;
            rows.push({ kind: 'reserve', id: row.id, row: reserved });
            if (row.state !== 'reserved') rows.push({ kind: 'settle', id: row.id, row });
          }
          const temporary = `${journal}.${randomUUID()}.tmp`;
          const migration = await fs.open(temporary, 'wx', 0o600);
          try { await migration.writeFile(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')); await migration.sync(); } finally { await migration.close(); }
          await fs.rename(temporary, journal);
        }
      }
      await replay(state.schemaVersion === 2 ? Number(state.journalBytes ?? 0) : 0, state.schemaVersion === 2 && Number(state.entriesCount ?? 0) > 0); overrun ||= state.overrun === true;
      const result = await update();
      const summary = { schemaVersion: 2, limitCny, committedCny: committed / 1e8, overrun, entriesCount: entries.size,
        journal: path.basename(journal), journalBytes: offset, updatedAt: new Date().toISOString() };
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(summary) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename);
      return result ?? { ...summary, entries: structuredClone([...entries.values()]) };
    } finally { await fs.rmdir(lock); }
  }
  return {
    reserve({ id, provider, maxCostCny, ...metadata }) {
      const amount = units(maxCostCny);
      if (!id || !provider || amount <= 0) throw new TypeError('Campaign identity and positive bound are required');
      return change(async () => {
        if (entries.has(id)) throw failure('campaign_request_already_reserved');
        if (overrun || committed + amount > limit) throw failure('campaign_budget_exhausted');
        const row = { ...metadata, id, provider, maxCostCny: amount / 1e8, state: 'reserved', uncertain: false, at: new Date().toISOString() };
        await append({ kind: 'reserve', id, row }); return structuredClone(row);
      });
    },
    settle({ id, costCny, uncertain = false }) {
      const amount = units(costCny);
      return change(async () => {
        const prior = entries.get(id); if (!prior || prior.state !== 'reserved') throw failure('campaign_reservation_not_open');
        const row = { ...prior, costCny: amount / 1e8, uncertain: uncertain || amount > units(prior.maxCostCny), state: 'settled', settledAt: new Date().toISOString(), maxCostCny: Math.max(amount, units(prior.maxCostCny)) / 1e8 };
        await append({ kind: 'settle', id, row }); return structuredClone(row);
      });
    },
    snapshot() { return change(async () => undefined); },
  };
}
