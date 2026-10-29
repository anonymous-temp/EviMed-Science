import assert from 'node:assert/strict'
import test from 'node:test'
import { before, after } from 'node:test'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs'

const configured = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL
const options = { skip: !configured && 'A local PostgreSQL fixture is required.' }
let fixture, database
before(async () => {
  if (!configured) return
  fixture = await createGeoTestDatabase(configured, 'txscope')
  database = new ControlPlaneDatabase({ databaseUrl: fixture.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 })
  await database.migrate()
  await database.query('CREATE TABLE scope_fixture(id integer PRIMARY KEY)')
})
after(async () => { await database?.close(); await fixture?.drop() })

test('real pool1 held queries and Promise.all savepoint peers preserve rollback isolation and reentry', options, async () => {
  await database.transaction(client => database.withTransactionClient(client, async () => {
    const peers = await Promise.allSettled([
      database.transaction(async c => { await c.query('INSERT INTO scope_fixture VALUES(1)'); await database.query('SELECT pg_sleep(0.03)') }),
      database.transaction(async c => { await c.query('INSERT INTO scope_fixture VALUES(2)'); throw new Error('rollback peer') }),
      database.transaction(async c => {
        await c.query('INSERT INTO scope_fixture VALUES(3)')
        await assert.rejects(database.transaction(async nested => { await nested.query('INSERT INTO scope_fixture VALUES(30)'); throw new Error('rollback child') }))
        await database.transaction(nested => nested.query('INSERT INTO scope_fixture VALUES(31)'))
      }),
    ])
    assert.deepEqual(peers.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled'])
    assert.deepEqual((await database.query('SELECT id FROM scope_fixture ORDER BY id')).rows.map(row => row.id), [1, 3, 31])
  }))
  assert.equal(database.pool.idleCount, 1)
})

test('same-database ownership is required and borrowers finish before the held client is released', options, async () => {
  const other = new ControlPlaneDatabase({ databaseUrl: fixture.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 })
  try {
    await database.transaction(client => assert.rejects(other.withTransactionClient(client, async () => {}), /not owned/u))
    let finished = false
    await database.transaction(client => database.withTransactionClient(client, async () => {
      void database.query('SELECT pg_sleep(0.05)').then(() => { finished = true })
    }))
    assert.equal(finished, true)
    assert.equal(database.pool.idleCount, 1)
  } finally { await other.close() }
})

test('detached closed-scope work rejects while explicit independently admitted work uses the pool', options, async () => {
  let detached, independent
  await database.transaction(client => database.withTransactionClient(client, async () => {
    detached = new Promise(resolve => setTimeout(async () => {
      try { await database.query('SELECT 1'); resolve(null) } catch (error) { resolve(error) }
    }, 30))
    independent = database.withoutTransactionClient(() => new Promise(resolve => setTimeout(async () => {
      try { resolve((await database.query('SELECT 1 AS value')).rows[0].value) } catch (error) { resolve(error) }
    }, 40)))
  }))
  assert.equal((await detached).code, 'product_revision_conflict')
  assert.equal(await independent, 1)
})

test('a nested transaction bounds only its own statements: its SET LOCAL timeouts end with its savepoint', options, async () => {
  // 2026-10-29: a runtime start runs inside the plugin admission's transaction; a GEO read in it set `statement_timeout = 5000`
  // in a savepoint, PostgreSQL kept it through RELEASE SAVEPOINT, and the start's next lock wait was cancelled after 5 s (57014).
  const bounds = async () => (await database.query("SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l")).rows[0]
  await database.transaction(client => database.withTransactionClient(client, async () => {
    const before = await bounds()
    await database.transaction(async c => {
      await c.query('SET LOCAL statement_timeout = 100')
      await c.query("SELECT set_config('lock_timeout', '50ms', true)")
    })
    assert.deepEqual(await bounds(), before, 'released: the enclosing transaction keeps its own bounds')
    await database.query('SELECT pg_sleep(0.3)')
    await assert.rejects(database.transaction(async c => { await c.query('SET LOCAL statement_timeout = 100'); throw new Error('rollback child') }))
    assert.deepEqual(await bounds(), before, 'rolled back: the same')
  }))
})
