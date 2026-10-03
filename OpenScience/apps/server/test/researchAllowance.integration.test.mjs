import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createWebApiApp } from '../src/server.mjs';
import { migrateEvimedCredits } from '../src/evimedCreditsPersistence.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !databaseUrl && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured' };
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

async function fixture(t, enabled = true) {
  const dataDir = await mkdtemp(path.join('/tmp', 'evimed-allowance-http-'));
  const wallet = { mode: 'ready', reads: [], deductions: 0 };
  const app = createWebApiApp({ dataDir, databaseUrl, stateStore: 'postgres', requireSharedStateStore: true,
    runtimeMode: 'mock', production: false, authMode: 'local', devAuth: false, bootstrapUser: '', bootstrapPassword: '',
    evimedCreditsEnabled: enabled, evimedCreditsPerCny: 1, researchBillingEnabled: false,
    evimedCreditsUrl: 'http://127.0.0.1:9999/deduct', evimedCreditsBalanceUrl: 'http://127.0.0.1:9999/balance', evimedApiKey: 'test-only-wallet-key',
    evimedCreditsFetch: async (url, init) => {
      const request = JSON.parse(init.body);
      if (String(url).endsWith('/deduct')) { wallet.deductions++; throw new Error('Read-only HTTP tests must never deduct.'); }
      wallet.reads.push(request);
      if (wallet.mode === 'unavailable') throw new Error('fixture wallet unavailable');
      if (wallet.mode === 'invalid') return Response.json({ code: 200, data: {} });
      return Response.json({ code: 200, data: { balance: '12.34567890', frozen: '100' } });
    },
  });
  const users = [];
  t.after(async () => {
    for (const user of users) {
      await app.store.database.query('DELETE FROM evimed_credits.research_task_requests WHERE run_id IN(SELECT run_id FROM evimed_credits.research_tasks WHERE user_id=$1)', [user.id]);
      await app.store.database.query('DELETE FROM evimed_credits.research_tasks WHERE user_id=$1', [user.id]);
      await app.store.database.query('DELETE FROM evimed_credits.settlements WHERE user_id=$1', [user.id]);
      await app.store.database.query('DELETE FROM evimed_control.users WHERE id=$1', [user.id]);
    }
    await app.close(); await rm(dataDir, { recursive: true, force: true });
  });
  await migrateEvimedCredits(app.store.database);
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  async function login(linked = true) {
    const name = `allowance${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const user = await app.store.createUser(name, 'test-only-billing-password', 'Allowance fixture');
    users.push(user);
    user.walletId = String(100000000 + users.length);
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'test-only-billing-password' }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (linked) await app.store.database.query("UPDATE evimed_control.users SET auth_type='evimed',evimed_user_id=$2 WHERE id=$1", [user.id, user.walletId]);
    return { user, headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'x-open-science-csrf': body.data.csrfToken } };
  }
  async function get(route, session, extra = {}) {
    const response = await fetch(`${base}/api/account/allowance${route}`, { headers: { ...session?.headers, ...extra } });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function task(user, runId, status, amount, at) {
    const evidence = { actualCny: '3.80000000', billableCny: '2.80000000', chargedCny: String(amount), waivedCny: '0.80000000', platformCostCny: '1.00000000', pricingVersion: 'fixture-policy', walletContract: 'legacy-integer-floor' };
    await app.store.database.query(`INSERT INTO evimed_credits.research_tasks(run_id,user_id,title,evidence,created_at,status,settled_at,owner_created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,(SELECT created_at FROM evimed_control.users WHERE id=$2))`, [runId,user.id,`研究 ${runId}`,JSON.stringify(evidence),at,status,status === 'settled' ? at : null]);
  }
  return { app, wallet, base, login, get, task };
}

test('authenticated allowance HTTP uses the upstream wallet and durable user-scoped statements', options, async (t) => {
  const suffix = randomUUID().replaceAll('-', '');
  const f = await fixture(t);
  const owner = await f.login(); const other = await f.login(); const unlinked = await f.login(false);
  const at = new Date().toISOString();
  await f.task(owner.user, `http_task_settled_${suffix}`, 'settled', 2, at);
  await f.task(owner.user, `http_task_pending_${suffix}`, 'pending', 5, at);
  await f.task(other.user, `http_other_private_${suffix}`, 'settled', 90, at);
  await f.app.store.database.query(`INSERT INTO evimed_credits.settlements(run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,created_at,settled_at,owner_created_at) VALUES($1,$2,$3,4.8,480,100,'settled',$4,$4,(SELECT created_at FROM evimed_control.users WHERE id=$2))`, [`http_legacy_${suffix}`,owner.user.id,'历史研究',at]);
  assert.equal((await f.get('', null)).status, 401);
  const allowance = await f.get(`?userId=${other.user.id}`, owner);
  assert.equal(allowance.status, 200);
  assert.match(allowance.headers.get('cache-control'), /private.*no-store/);
  assert.equal(allowance.body.data.available, 12.3456789);
  assert.equal(allowance.body.data.held, null);
  assert.equal(allowance.body.data.balances, null);
  assert.equal(allowance.body.data.membership, null);
  assert.equal(allowance.body.data.month.paid, 6.8);
  assert.equal(allowance.body.data.month.pending, 5);
  assert.equal(f.wallet.reads.at(-1).userId, owner.user.walletId);
  const first = await f.get('/statements?limit=1', owner);
  assert.equal(first.status, 200); assert.equal(first.body.data.items.length, 1);
  const all = [...first.body.data.items]; let cursor = first.body.data.nextCursor;
  while (cursor) {
    const page = await f.get(`/statements?limit=1&cursor=${encodeURIComponent(cursor)}`, owner);
    assert.equal(page.status, 200); all.push(...page.body.data.items); cursor = page.body.data.nextCursor;
  }
  assert.equal(all.length, 3); assert.equal(new Set(all.map(row => row.id)).size, 3);
  assert.ok(all.some(row => row.id === `http_legacy_${suffix}` && row.amount === 4.8));
  assert.ok(all.some(row => row.id === `http_task_settled_${suffix}` && row.amount === 2));
  assert.ok(all.some(row => row.id === `http_task_pending_${suffix}` && row.status === 'pending' && row.amount === null));
  assert.ok(!JSON.stringify(all).includes(`http_other_private_${suffix}`));
  const forged = await f.get(`/statements?userId=${other.user.id}`, owner);
  assert.equal(forged.body.data.items.length, 3);
  assert.equal((await f.get('/statements?limit=0', owner)).status, 400);
  assert.equal((await f.get('/statements?cursor=not-json', owner)).status, 400);
  assert.equal((await f.get('/statements?limit=1&limit=2', owner)).status, 400);
  assert.equal((await f.get('', unlinked)).body.data.status, 'unlinked');
  f.wallet.mode = 'unavailable';
  const unavailable = await f.get('', owner);
  assert.equal(unavailable.status, 200); assert.equal(unavailable.body.data.status, 'unavailable'); assert.equal(unavailable.body.data.available, null);
  f.wallet.mode = 'invalid';
  assert.equal((await f.get('', owner)).body.data.available, null);
  assert.equal(f.wallet.deductions, 0);
});

test('disabled billing is explicit and has no fabricated wallet or checkout', options, async (t) => {
  const f = await fixture(t, false); const owner = await f.login();
  const result = await f.get('', owner);
  assert.equal(result.status, 200); assert.equal(result.body.data.status, 'disabled'); assert.equal(result.body.data.available, null);
  assert.deepEqual(result.body.data.commerce, { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null });
  assert.deepEqual((await f.get('/statements', owner)).body.data, { items: [], nextCursor: null });
  assert.equal(f.wallet.reads.length, 0); assert.equal(f.wallet.deductions, 0);
});

test('commerce HTTP links come only from trusted deployment configuration', options, async (t) => {
  const env = {
    OPEN_SCIENCE_RESEARCH_COMMERCE_ENABLED: 'true', OPEN_SCIENCE_RESEARCH_COMMERCE_TRUSTED_ORIGINS: 'https://account.example.com',
    OPEN_SCIENCE_RESEARCH_COMMERCE_RECHARGE_URL: 'https://account.example.com/recharge', OPEN_SCIENCE_RESEARCH_COMMERCE_ORDERS_URL: 'https://untrusted.example.com/orders',
    OPEN_SCIENCE_RESEARCH_COMMERCE_MEMBERSHIP_URL: 'javascript:alert(1)', OPEN_SCIENCE_RESEARCH_COMMERCE_REFUNDS_URL: 'https://account.example.com/refunds',
  };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const f = await fixture(t, false); const owner = await f.login();
  const result = await f.get('?rechargeUrl=https://attacker.example.com/pay', owner);
  assert.deepEqual(result.body.data.commerce, { rechargeUrl: 'https://account.example.com/recharge', membershipUrl: null, ordersUrl: null, refundsUrl: 'https://account.example.com/refunds' });
  assert.equal((await fetch(`${f.base}/api/account/allowance`, { method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json' }, body: JSON.stringify({ rechargeUrl: 'https://attacker.example.com/pay' }) })).status, 405);
  assert.equal(f.wallet.deductions, 0);
});

test('HTTP account erasure retains redacted financial evidence but a recreated id cannot read it', options, async (t) => {
  const f = await fixture(t); const owner = await f.login(false);
  const suffix = randomUUID().replaceAll('-', '');
  const taskId = `erased_task_${suffix}`; const legacyId = `erased_legacy_${suffix}`;
  const at = new Date().toISOString();
  await f.task(owner.user, taskId, 'settled', 2, at);
  await f.app.store.database.query(`INSERT INTO evimed_credits.settlements
    (run_id,user_id,memo,cost_cny,credits,credits_per_cny,status,created_at,settled_at,owner_created_at)
    VALUES($1,$2,'Private research subject',3,3,1,'settled',$3,$3,(SELECT created_at FROM evimed_control.users WHERE id=$2))`, [legacyId,owner.user.id,at]);
  const initial = await f.get('/statements', owner);
  assert.equal(initial.status, 200); assert.equal(initial.body.data.items.length, 2);
  const deletion = await fetch(`${f.base}/api/account`, { method: 'DELETE', headers: { ...owner.headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: owner.user.id, password: 'test-only-billing-password' }) });
  assert.equal(deletion.status, 200, JSON.stringify(await deletion.json()));
  assert.equal((await f.get('/statements', owner)).status, 401);
  const retained = await f.app.store.database.query(`SELECT title AS prose FROM evimed_credits.research_tasks WHERE run_id=$1 UNION ALL SELECT memo FROM evimed_credits.settlements WHERE run_id=$2`, [taskId,legacyId]);
  assert.equal(retained.rows.length, 2, 'financial records must survive account deletion');
  assert.deepEqual(retained.rows.map(row => row.prose), ['Research task', 'Research task']);
  const registration = await fetch(`${f.base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: owner.user.id, password: 'test-only-billing-password', name: 'New account incarnation' }) });
  const registered = await registration.json();
  assert.equal(registration.status, 201, JSON.stringify(registered));
  assert.equal(registered.data.user.id, owner.user.id);
  const reincarnation = { headers: { cookie: registration.headers.get('set-cookie').split(';')[0], 'x-open-science-csrf': registered.data.csrfToken } };
  const statements = await f.get('/statements', reincarnation);
  assert.equal(statements.status, 200); assert.deepEqual(statements.body.data, { items: [], nextCursor: null });
  const summary = await f.get('', reincarnation);
  assert.equal(summary.status, 200); assert.equal(summary.body.data.month.paid, 0); assert.equal(summary.body.data.month.pending, 0);
  assert.equal(summary.body.data.available, null); assert.equal(summary.body.data.status, 'unlinked');
  assert.equal(f.wallet.reads.length, 0); assert.equal(f.wallet.deductions, 0);
});
