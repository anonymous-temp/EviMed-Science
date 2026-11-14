import assert from 'node:assert/strict';
import test from 'node:test';
import { relationalIntegrity } from '../src/relationalIntegrity.mjs';

const historyTables = ['history_message_rejections', 'history_write_messages', 'history_secret_salts', 'history_secrets'];

/** @param {boolean | null} validated */
function fixture(validated) {
  /** @type {string[]} */ const statements = [];
  return { statements, database: {
    /** @param {string} sql */
    async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM pg_constraint')) return { rows: validated === null ? [] : historyTables.map(table => ({
        schema_name: 'evimed_memory', table_name: table, conname: `${table}_owner_fk`, convalidated: validated,
        definition: `FOREIGN KEY (owner_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE${validated ? '' : ' NOT VALID'}`,
      })) };
      return { rows: [{ count: historyTables.some(table => sql.includes(`evimed_memory.${table} `)) ? 2 : 0 }] };
    },
    async transaction() { throw new Error('a read-only audit must not start a transaction'); },
  } };
}

test('all four capsule hash/salt owner keys report legacy orphan debt when unvalidated', async () => {
  const f = fixture(false);
  const status = await relationalIntegrity(f.database);
  for (const table of historyTables) {
    assert.equal(status.counts[`memory_${table}_owner`], 2, table);
    assert.ok(status.unvalidated.includes(`memory_${table}_owner`), table);
  }
  assert.equal(status.orphanTotal, 8);
  assert.equal(status.ok, false);
});

test('validated capsule owner keys prove their counts without reading history tables', async () => {
  const f = fixture(true);
  const status = await relationalIntegrity(f.database);
  for (const table of historyTables) {
    assert.equal(status.counts[`memory_${table}_owner`], 0, table);
    assert.ok(status.proven.includes(`memory_${table}_owner`), table);
    assert.ok(!f.statements.some(sql => sql.includes(`FROM evimed_memory.${table} `)), table);
  }
});

test('a missing capsule owner key is a readiness failure rather than an optional table', async () => {
  const status = await relationalIntegrity(fixture(null).database);
  for (const table of historyTables) assert.ok(status.missing.includes(`memory_${table}_owner`), table);
  assert.equal(status.ok, false);
});
