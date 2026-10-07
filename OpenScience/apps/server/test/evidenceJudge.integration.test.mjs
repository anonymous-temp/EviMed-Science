import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { migrateEvidenceZones } from '../src/evidenceZonePersistence.mjs';
import { createEvidenceTopicRequests } from '../src/evidencePublicRequests.mjs';
import { createEvidenceCardSearch } from '../src/evidenceCardSearch.mjs';
import { EvidenceZoneSubscriptions } from '../src/evidenceZoneSubscription.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'local PostgreSQL required' };
let isolated, database;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'evidencejudge');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateEvidenceZones(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('bob','p1','Project',1048576),('bob','p2','Other',1048576),('alice','p1','Attribution',1048576)");
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('J14 same uses existing votes; related links both directions without merging votes or zone links', options, async () => {
  let relation = 'different';
  const requests = createEvidenceTopicRequests({ database, config: { evidenceTopicRequestsPerDay: 10 },
    judgeContext: async user => ({ userId: user.id, projectId: 'p1' }),
    judgeService: { judge: async (site) => { assert.equal(site, 'J14'); return { outcome: 'settled', value: { relation } }; } } });
  const first = await requests.file({ id: 'alice' }, { title: 'Atrial fibrillation stroke prevention' });
  relation = 'same';
  const second = await requests.file({ id: 'bob' }, { title: 'Preventing stroke in atrial fibrillation' });
  assert.equal(second.request.id, first.request.id); assert.equal(second.request.requesters, 2);
  assert.equal(second.filed, false);
  const repeat = await requests.file({ id: 'bob' }, { title: 'Atrial fibrillation stroke prevention' });
  assert.equal(repeat.alreadySeconded, true); assert.equal(repeat.request.requesters, 2);
  relation = 'related';
  const related = await requests.file({ id: 'alice' }, { title: 'Bleeding outcomes in atrial fibrillation' });
  assert.notEqual(related.request.id, first.request.id); assert.equal(related.request.requesters, 1);
  assert.deepEqual(related.request.relatedRequestIds, [first.request.id]);
  const list = await requests.list();
  assert.deepEqual(list.items.find(r => r.id === first.request.id).relatedRequestIds, [related.request.id]);
  assert.equal(list.items.find(r => r.id === first.request.id).requesters, 2);
  assert.equal((await database.query('SELECT * FROM evimed_frontier.evidence_topic_request_links')).rows.length, 1);
  assert.equal((await database.query('SELECT * FROM evimed_frontier.evidence_topic_request_votes')).rows.length, 3);
});

test('J13 sends only published subscribed cards, preserves cards, and never recalls another tenant/project', options, async () => {
  const zone = 'ez_aaaaaaaaaaaaaaaa'; const draft = 'ez_bbbbbbbbbbbbbbbb';
  await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES($1,'alice','Evidence','published'),($2,'alice','Private','draft')", [zone, draft]);
  for (const [id, zoneId, state] of [['ec_aaaaaaaa',zone,'published'],['ec_bbbbbbbb',zone,'published'],['ec_cccccccc',zone,'draft'],['ec_dddddddd',draft,'published']])
    await database.query("INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,state,summary) VALUES($1,$2,'alice','stroke prevention','academic',$3,'stroke evidence')", [id,zoneId,state]);
  const calls = [];
  const judgeService = { judge: async (site, input) => {
    assert.equal(site, 'J13'); calls.push(input);
    assert.deepEqual(new Set(input.cards.map(c => c.id)), new Set(['ec_aaaaaaaa','ec_bbbbbbbb']));
    return { outcome: 'settled', value: { rankedIds: ['ec_bbbbbbbb','ec_aaaaaaaa'] } };
  } };
  const search = createEvidenceCardSearch({ database, judgeService });
  assert.deepEqual((await search.search({ id: 'bob' }, { q: 'stroke', limit: 5 }, { projectId: 'p1' })).cards.map(c => c.id), ['ec_bbbbbbbb','ec_aaaaaaaa']);
  const subscriptions = new EvidenceZoneSubscriptions({ database, documents: new ProductDocuments(database), enabled: true, judgeService });
  await subscriptions.subscribe('bob', 'p1', zone);
  assert.deepEqual((await subscriptions.recall('bob', 'p1', 'stroke prevention')).map(c => c.id), ['ec_bbbbbbbb','ec_aaaaaaaa']);
  assert.deepEqual(await subscriptions.recall('alice', 'p1', 'stroke prevention'), []);
  assert.deepEqual(await subscriptions.recall('bob', 'p2', 'stroke prevention'), []);
  assert.equal(calls.length, 2);
});


test('J14 uncertainty and failures retain separate requests, exact title votes, and reject private zones before judging', options, async () => {
  let calls = 0;
  const requests = createEvidenceTopicRequests({ database, config: { evidenceTopicRequestsPerDay: 50 },
    judgeContext: async user => ({ userId: user.id, projectId: 'p1' }),
    judgeService: { judge: async () => { calls += 1; return { outcome: 'escalated' }; } } });
  const first = await requests.file({ id: 'alice' }, { title: 'Uncertain kidney disease topic' });
  const second = await requests.file({ id: 'bob' }, { title: 'Kidney disease topic uncertainty' });
  assert.notEqual(second.request.id, first.request.id);
  assert.deepEqual(second.request.relatedRequestIds, []);
  const previous = calls;
  const repeat = await requests.file({ id: 'bob' }, { title: '  UNCERTAIN kidney disease topic  ' });
  assert.equal(repeat.request.id, first.request.id); assert.equal(calls, previous);
  await assert.rejects(requests.file({ id: 'bob' }, { title: 'Private zone attempt', zoneId: 'ez_bbbbbbbbbbbbbbbb' }), { code: 'evidence_topic_request_invalid' });
  assert.equal(calls, previous);
  const broken = createEvidenceTopicRequests({ database, config: { evidenceTopicRequestsPerDay: 50 },
    judgeContext: async user => ({ userId: user.id, projectId: 'p1' }),
    judgeService: { judge: async () => { throw Error('unavailable'); } } });
  const third = await broken.file({ id: 'alice' }, { title: 'Independent kidney disease question' });
  assert.equal(third.filed, true); assert.deepEqual(third.request.relatedRequestIds, []);
  const link = (await database.query('SELECT * FROM evimed_frontier.evidence_topic_request_links')).rows[0];
  await assert.rejects(database.query('INSERT INTO evimed_frontier.evidence_topic_request_links(left_id,right_id) VALUES($1,$2)', [link.right_id, link.left_id]), { code: '23514' });
  await assert.rejects(database.query('INSERT INTO evimed_frontier.evidence_topic_request_links(left_id,right_id) VALUES($1,$2)', [link.left_id, 'zz_missing']), { code: '23503' });
});

test('actual JudgeService and durable ledger bill J13 to the real project and retain J14 spend after a vote rollback', options, async () => {
  const { UsageLedger } = await import('../src/usageLedger.mjs');
  const { createJudgeService } = await import('../src/judgeService.mjs');
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('quota','Quota','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('quota','p1','Attribution',1048576)");
  let spentQuota = false;
  const judge = createJudgeService({ calibrationMode: true, database, usageLedger: new UsageLedger(database),
    config: { typesafeApiKey: 'test-only-key', reviewJevModel: 'jev-1.13.0', reviewJevApiBase: 'https://jev.test/v1', requireDurableUsageLedger: true },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      // No topic mutation lock is held while the provider and ledger work run.
      const locks = await database.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=(hashtext('evidence-topic-request:semantic')::bigint & 4294967295)");
      assert.equal(locks.rows.length, 0);
      if (body.questions.relation && !spentQuota) {
        spentQuota = true;
        // The day's one request goes to a topic other than the pair being judged: one voted on the request the judge
        // then calls the same would count as already held, and the refusal this test is about would not happen.
        // (Picking the first request by id made that a coin toss on random ids; CI lost it on 2026-10-07.)
        const judged = [body.state.left, body.state.right].filter((value) => typeof value === 'string');
        const target = (await database.query('SELECT id FROM evimed_frontier.evidence_topic_requests WHERE NOT (title = ANY($1::text[])) ORDER BY id LIMIT 1', [judged])).rows[0].id;
        await database.query('INSERT INTO evimed_frontier.evidence_topic_request_votes(request_id,user_id) VALUES($1,$2)', [target,'quota']);
      }
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const selected = id === 'relation' ? 'same' : 'related';
        return [id, { type: 'choice', choice: selected, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) }];
      }));
      return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 5 } });
    } });
  try {
    const search = createEvidenceCardSearch({ database, judgeService: judge });
    assert.equal((await search.search({ id: 'bob' }, { q: 'stroke' }, { projectId: 'p1' })).cards.length, 2);
    const billed = (await database.query("SELECT project_id,status FROM evimed_usage.model_requests WHERE operation='J13' AND user_id='bob'")).rows;
    assert.equal(billed.length, 1); assert.equal(billed[0].project_id, 'p1'); assert.equal(billed[0].status, 'settled');
    const requests = createEvidenceTopicRequests({ database, config: { evidenceTopicRequestsPerDay: 1 }, judgeService: judge,
      judgeContext: async user => ({ userId: user.id, projectId: 'p1' }) });
    await assert.rejects(requests.file({ id: 'quota' }, { title: 'Attribution proof independent question' }), { code: 'evidence_topic_request_limit' });
    const rows = (await database.query("SELECT project_id,status FROM evimed_usage.model_requests WHERE operation='J14' AND user_id='quota'")).rows;
    assert.equal(rows.length, 2, 'both ordered paid calls remain recorded after authoritative vote quota rejection');
    assert.ok(rows.every(row => row.status === 'settled' && row.project_id === 'p1'));
    assert.equal((await database.query("SELECT 1 FROM evimed_frontier.evidence_topic_requests WHERE title_key='attribution proof independent question'")).rows.length, 0);
  } finally { await judge.close(); }
});

test('concurrent semantic filing rechecks changed candidates outside locks and retains both accounts votes', options, async () => {
  const requests = createEvidenceTopicRequests({ database, config: { evidenceTopicRequestsPerDay: 50 },
    judgeContext: async user => ({ userId: user.id, projectId: 'p1' }),
    judgeService: { judge: async (_site, input) => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return { outcome: 'settled', value: { relation: input.right.includes('Concurrent marker') ? 'same' : 'different' } };
    } } });
  const [left, right] = await Promise.all([
    requests.file({ id: 'alice' }, { title: 'Concurrent marker original formulation' }),
    requests.file({ id: 'bob' }, { title: 'Concurrent marker alternate formulation' }),
  ]);
  assert.equal(left.request.id, right.request.id);
  assert.equal((await requests.list()).items.find(item => item.id === left.request.id).requesters, 2);
});

test('missing or unavailable trusted attribution preserves title filing without paid work', options, async () => {
  let calls = 0;
  const judgeService = { judge: async () => { calls++; return { outcome: 'settled', value: { relation: 'same' } }; } };
  for (const [index, judgeContext] of [null, async () => { throw Error('account unavailable'); }, async () => ({ userId: 'other-tenant', projectId: 'p1' })].entries()) {
    const requests = createEvidenceTopicRequests({ database, config: { evidenceTopicRequestsPerDay: 50 }, judgeService, judgeContext });
    const filed = await requests.file({ id: 'bob' }, { title: `Missing trusted attribution fallback ${index}` });
    assert.equal(filed.filed, true); assert.deepEqual(filed.request.relatedRequestIds, []);
  }
  assert.equal(calls, 0);
});
